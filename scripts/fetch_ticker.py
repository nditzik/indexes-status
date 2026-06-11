"""
fetch_ticker.py — pulls Yahoo Finance prices server-side and writes
to data/live_ticker.json. Called by .github/workflows/update-ticker.yml
on a 5-minute cron during US trading hours.

Why server-side: public CORS proxies (jina, allorigins, codetabs, ...)
all rate-limit unpredictably depending on user IP/region. A GitHub
Actions runner has a clean IP and Yahoo doesn't rate-limit our usage.
The browser then reads /data/live_ticker.json same-origin — no proxy
needed, 100% reliable.

Skips the commit if values haven't changed by >0.05% on any ticker.
Keeps the git history sane.
"""
import json, os, sys, urllib.request, urllib.error
from datetime import datetime, timezone

# Indices (ETFs) + the macro trio: fear index, 10Y treasury yield,
# dollar index. Yahoo symbols with ^ get URL-quoted in fetch_one.
SYMBOLS = ['SPY', 'QQQ', 'DIA', 'IWM', '^VIX', '^TNX', 'DX-Y.NYB']
ENDPOINT = 'https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1d&range=2d'
OUTPUT   = 'data/live_ticker.json'
SKIP_THRESHOLD_PCT = 0.05  # don't bother committing for sub-0.05% wiggles


def fetch_one(symbol):
    from urllib.parse import quote
    url = ENDPOINT.format(sym=quote(symbol, safe=''))
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (compatible; indexes-status-ticker/1.0)',
        'Accept': 'application/json',
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            if r.status != 200:
                return None
            data = json.load(r)
    except Exception as e:
        print(f'  {symbol}: fetch failed: {e}', file=sys.stderr)
        return None
    try:
        result = data['chart']['result'][0]
        meta = result['meta']
        # IMPORTANT: meta.chartPreviousClose returns the close BEFORE the
        # requested range. With range=2d that's the close from 3 trading
        # days ago, not yesterday — gives wrong %change.
        # Correct approach: read the timeseries. With range=2d, close[0]
        # is yesterday's close and close[-1] is today's. Use yesterday's
        # close as `prev` so today/yesterday %change is real.
        closes = result.get('indicators', {}).get('quote', [{}])[0].get('close', [])
        clean = [c for c in closes if c is not None]
        prev = None
        # Cases:
        #   2 valid closes → market closed today, closes = [yesterday, today].
        #                   `prev` = closes[-2] (yesterday).
        #   1 valid close  → market still open or data not finalized.
        #                   The only entry IS yesterday's close. Use it.
        #   0 valid closes → fall back to chartPreviousClose (less accurate).
        if len(clean) >= 2:
            prev = clean[-2]
        elif len(clean) == 1:
            prev = clean[0]
        else:
            prev = meta.get('chartPreviousClose')
        return {
            'symbol': symbol,
            'price': meta.get('regularMarketPrice'),
            'prev':  prev,
            'time':  meta.get('regularMarketTime'),
            'state': meta.get('marketState'),
        }
    except (KeyError, IndexError, TypeError) as e:
        print(f'  {symbol}: parse failed: {e}', file=sys.stderr)
        return None


def load_existing():
    try:
        with open(OUTPUT, encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def should_skip_commit(new_data, old_data):
    if not old_data or 'tickers' not in old_data:
        return False
    old_by_sym = {t['symbol']: t for t in old_data['tickers']}
    for t in new_data['tickers']:
        old = old_by_sym.get(t['symbol'])
        if not old or old.get('price') is None or t.get('price') is None:
            return False
        if old['price'] == 0:
            return False
        delta_pct = abs(t['price'] - old['price']) / old['price'] * 100
        if delta_pct >= SKIP_THRESHOLD_PCT:
            return False
    return True


def main():
    print(f'Fetching {len(SYMBOLS)} symbols from Yahoo...')
    tickers = []
    for sym in SYMBOLS:
        result = fetch_one(sym)
        if result:
            tickers.append(result)
            print(f'  {sym}: ${result["price"]:.2f} (prev ${result["prev"]:.2f})')
    if not tickers:
        print('All symbols failed — leaving existing file untouched', file=sys.stderr)
        sys.exit(1)
    new_data = {
        'fetchedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'yahoo-v8-chart',
        'tickers': tickers,
    }
    old_data = load_existing()
    if should_skip_commit(new_data, old_data):
        # Bump the fetchedAt timestamp anyway so the dashboard knows we
        # checked. But we'll signal via exit code that no commit needed.
        new_data['fetchedAt'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        with open(OUTPUT, 'w', encoding='utf-8') as f:
            json.dump(new_data, f, ensure_ascii=False, indent=2)
        print(f'No material change (>{SKIP_THRESHOLD_PCT}% threshold) — file updated, suggest skip commit.')
        sys.exit(2)
    with open(OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(new_data, f, ensure_ascii=False, indent=2)
    print(f'Wrote {OUTPUT} ({len(tickers)} tickers, source: yahoo)')


if __name__ == '__main__':
    main()
