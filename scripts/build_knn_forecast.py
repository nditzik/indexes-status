"""
build_knn_forecast.py — the "צפי מול בפועל" (forecast vs actual) series
for the KNN tab.

For each locked-in KNN snapshot, the historical analogs already implied a
20-trading-day forward-return BAND — stored in the snapshot's
`outcomes["20"]` as {min, median, max}. This attaches the ACTUAL 20-day
SPX return realized from the anchor day, once 20 sessions have elapsed, so
the chart can show the real index threading through the forecast band.

Display only: reads data/forward_snapshots.json + the watchlist SPX series;
writes data/knn_forecast.json. Newer anchors carry the band alone (actual
= null) until they mature. Wide band = full min–max of the analogs
(user choice); horizon = 20 days only.
"""
import csv
import io
import glob
import json
import re

WL_RE = re.compile(r'watchlist-sp-500-intraday-(\d{2})-(\d{2})-(\d{4})\.csv$')
HORIZON = 20  # trading days — the only horizon (user request)


def spx_price_by_date():
    """{ 'YYYY-MM-DD': spx_close } from every watchlist CSV (mirrors
    build_score_forward.spx_price_by_date)."""
    out = {}
    for p in glob.glob('data/watchlist-sp-500-intraday-*.csv'):
        g = WL_RE.search(p)
        if not g:
            continue
        mm, dd, yyyy = g.groups()
        iso = f'{yyyy}-{mm}-{dd}'
        try:
            txt = open(p, encoding='utf-8-sig').read().replace('\r\n', '\n')
        except OSError:
            continue
        for r in csv.DictReader(io.StringIO(txt)):
            if (r.get('Symbol') or '').strip() == '$SPX':
                v = (r.get('Latest') or '').replace(',', '').strip()
                try:
                    out[iso] = float(v)
                except ValueError:
                    pass
                break
    return out


def _r2(v):
    return round(v, 2) if v is not None else None


def build():
    try:
        snaps = json.load(open('data/forward_snapshots.json',
                               encoding='utf-8')).get('snapshots', [])
    except (FileNotFoundError, json.JSONDecodeError):
        snaps = []
    prices = spx_price_by_date()
    days = sorted(prices.keys())
    idx = {d: i for i, d in enumerate(days)}

    rows = []
    for s in snaps:
        d = s.get('anchorDate')
        oc = (s.get('outcomes') or {}).get(str(HORIZON))
        if not d or not oc:
            continue
        row = {
            'date': d,
            'fcMin': _r2(oc.get('min')),        # wide band — pessimistic analog
            'fcMax': _r2(oc.get('max')),        # wide band — optimistic analog
            'fcMedian': _r2(oc.get('median')),  # forecast centre
            'actual': None,
            'hit': None,
        }
        # Actual realized 20-session SPX return from the anchor day.
        i = idx.get(d)
        p0 = prices.get(d)
        if i is not None and p0 and i + HORIZON < len(days):
            actual = round((prices[days[i + HORIZON]] / p0 - 1) * 100, 2)
            row['actual'] = actual
            if row['fcMin'] is not None and row['fcMax'] is not None:
                row['hit'] = bool(row['fcMin'] <= actual <= row['fcMax'])
        rows.append(row)

    matured = [r for r in rows if r['actual'] is not None]
    hits = [r for r in matured if r['hit']]
    return {
        'horizon': HORIZON,
        'hitRate': round(len(hits) / len(matured), 3) if matured else None,
        'maturedCount': len(matured),
        'total': len(rows),
        'series': rows,
    }


def main():
    out = build()
    with open('data/knn_forecast.json', 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"Wrote data/knn_forecast.json ({out['total']} snapshots, "
          f"{out['maturedCount']} matured, hitRate={out['hitRate']})")


if __name__ == '__main__':
    main()
