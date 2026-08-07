"""
build_ai_analysis.py — the daily AI analyst note.

Packages the trading day's rich data (breadth internals, the actual
leaders/laggards BY NAME, the largest individual option trades, flow,
rotation, what changed) into a prompt and asks Claude to write a short,
specific market analysis — the kind of depth the rule-based conclusion
can't produce. Output: data/ai_analysis.json, rendered as the lead card
on the dashboard's main page.

SAFETY: does nothing unless ANTHROPIC_API_KEY is set — so it never
overwrites a hand-written note when the key is absent (e.g. before the
GitHub secret is added). The deterministic scores are untouched; this
only adds prose on top.

Env:
  ANTHROPIC_API_KEY   required — the note is skipped without it.
  AI_MODEL            optional — defaults to claude-sonnet-5.
"""
import csv
import glob
import io
import json
import os
import re
import sys
import urllib.request
import urllib.error

MODEL = os.environ.get('AI_MODEL', 'claude-sonnet-5')
MEGA = ['NVDA', 'MSFT', 'AAPL', 'GOOGL', 'AMZN', 'META', 'AVGO', 'TSLA']
WL_RE = re.compile(r'watchlist-sp-500-intraday-(\d{2})-(\d{2})-(\d{4})\.csv$')
FL_RE = re.compile(r'spx-options-flow-(\d{2})-(\d{2})-(\d{4})\.csv$')


def _num(v):
    try:
        return float(str(v).replace(',', '').replace('%', '').strip())
    except (ValueError, AttributeError):
        return None


def _latest(pattern, date_re):
    def key(p):
        m = date_re.search(p)
        return f'{m.group(3)}-{m.group(1)}-{m.group(2)}' if m else ''
    files = sorted(glob.glob(pattern), key=key)
    return files[-1] if files else None


def gather():
    """Collect the day's data into a compact dict for the prompt."""
    ctx = {}
    try:
        ctx['state'] = json.load(open('data/daily_state.json', encoding='utf-8'))
    except Exception:
        ctx['state'] = {}
    try:
        ctx['sectorNames'] = json.load(open('data/sectors.json', encoding='utf-8')).get('codes', {})
    except Exception:
        ctx['sectorNames'] = {}

    wl = _latest('data/watchlist-sp-500-intraday-*.csv', WL_RE)
    stocks = []
    if wl:
        rows = list(csv.DictReader(io.StringIO(open(wl, encoding='utf-8-sig').read())))
        for r in rows:
            s = (r.get('Symbol') or '').strip()
            if not s or s.startswith('$') or s == 'RSP':
                continue
            chg = _num(r.get('%Change'))
            latest, ma50 = _num(r.get('Latest')), _num(r.get('50D MA'))
            if chg is None or abs(chg) >= 50:
                continue
            stocks.append({'s': s, 'chg': chg, 'aboveMa50': bool(ma50 and latest and latest > ma50)})
    stocks.sort(key=lambda x: -x['chg'])
    ctx['up'] = sum(1 for x in stocks if x['chg'] > 0)
    ctx['down'] = sum(1 for x in stocks if x['chg'] < 0)
    ctx['total'] = len(stocks)
    ctx['leaders'] = [f"{x['s']} {x['chg']:+.1f}%" for x in stocks[:8]]
    ctx['laggards'] = [f"{x['s']} {x['chg']:+.1f}%" for x in stocks[-8:][::-1]]
    ctx['megacaps'] = [f"{x['s']} {x['chg']:+.1f}% ({'above' if x['aboveMa50'] else 'below'} MA50)"
                       for x in stocks if x['s'] in MEGA]

    fl = _latest('data/spx-options-flow-*.csv', FL_RE)
    trades, callP, putP = [], 0.0, 0.0
    if fl:
        for r in csv.DictReader(io.StringIO(open(fl, encoding='utf-8-sig').read())):
            prem = _num(r.get('Premium')) or 0
            typ = (r.get('Type') or '').strip()
            strike = _num(r.get('Strike'))
            side = (r.get('Side') or '').strip()
            exp = (r.get('Exp Date') or r.get('Expires') or '').strip()[:10]
            trades.append((prem, typ, strike, side, exp))
            if typ.lower() == 'call':
                callP += prem
            elif typ.lower() == 'put':
                putP += prem
    trades.sort(key=lambda t: -t[0])
    ctx['bigTrades'] = [f"${p/1e6:.0f}M {t} {int(k) if k else '?'} {sd} exp {e}"
                        for p, t, k, sd, e in trades[:6]]
    ctx['callPremB'] = round(callP / 1e9, 2)
    ctx['putPremB'] = round(putP / 1e9, 2)
    return ctx


def build_prompt(ctx):
    st = ctx.get('state', {})
    sc = st.get('scores', {})
    concl = (st.get('conclusion') or {})
    flow = (st.get('flow') or {})
    rot = (st.get('rotation') or {})
    ev = (st.get('evidence') or {})
    names = ctx.get('sectorNames', {})
    leading = ' · '.join(names.get(c, c) for c in rot.get('leadingSectors', [])) or 'none'
    data = f"""Trading day: {st.get('date')}
Scores (0-100): Tech {sc.get('tech')}, Breadth {sc.get('breadth')}, Flow {sc.get('flow')}, Combined {sc.get('combined')}
VIX: {ev.get('vix')} | % stocks above MA200: {ev.get('pctMa200')} | EQ500-vs-SPX 20d spread: {ev.get('eqSpx20')}
Advancers/decliners: {ctx.get('up')} up vs {ctx.get('down')} down (of {ctx.get('total')})
Today's leaders: {', '.join(ctx.get('leaders', []))}
Today's laggards: {', '.join(ctx.get('laggards', []))}
Mega-caps: {', '.join(ctx.get('megacaps', []))}
Options flow: score {sc.get('flow')} ({flow.get('directionLabel')}), {flow.get('directionReason')}, Mid {flow.get('midPct')}%, {flow.get('compareLine')}
Total option premium: Calls ${ctx.get('callPremB')}B / Puts ${ctx.get('putPremB')}B
Largest individual option trades: {'; '.join(ctx.get('bigTrades', []))}
Persistent leading sectors (RS>0 on 5d+20d): {leading}
What changed vs the prior reading: {', '.join(concl.get('change', [])) or 'little'}"""

    instructions = (
        "You are a sharp, honest markets analyst writing the morning note for a "
        "Hebrew-speaking retail investor about the US stock market (S&P 500). "
        "Below is today's real data. Write a SPECIFIC analysis in SIMPLE HEBREW — "
        "name the actual stocks and numbers, read the big option trades as a story, "
        "connect the signals across breadth/flow/rotation, and lead with the day's "
        "central TENSION or story (not a generic label). Be concrete, not templated. "
        "Say honestly when signals conflict or the picture is ambiguous. Do NOT give "
        "financial advice or price targets. "
        "Return ONLY a JSON object, no markdown, with exactly these keys: "
        '"headline" (a short punchy Hebrew title), '
        '"paragraphs" (array of 3-4 short Hebrew paragraphs), '
        '"watchFor" (one Hebrew sentence: the specific triggers that would change the picture), '
        '"confidence" (one Hebrew word: "גבוה" / "בינוני" / "נמוך"). '
        "\n\nDATA:\n" + data
    )
    return instructions


def call_claude(prompt, api_key):
    body = json.dumps({
        'model': MODEL,
        'max_tokens': 1600,
        'messages': [{'role': 'user', 'content': prompt}],
    }).encode()
    req = urllib.request.Request(
        'https://api.anthropic.com/v1/messages',
        data=body,
        headers={
            'x-api-key': api_key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        payload = json.loads(resp.read().decode())
    text = ''.join(b.get('text', '') for b in payload.get('content', []) if b.get('type') == 'text')
    # Be tolerant of stray prose around the JSON.
    m = re.search(r'\{.*\}', text, re.DOTALL)
    return json.loads(m.group(0) if m else text)


def main():
    api_key = os.environ.get('ANTHROPIC_API_KEY', '').strip()
    if not api_key:
        print('ANTHROPIC_API_KEY not set -> skipping AI analysis '
              '(existing data/ai_analysis.json left untouched).')
        return 0
    ctx = gather()
    date = (ctx.get('state') or {}).get('date')
    try:
        out = call_claude(build_prompt(ctx), api_key)
    except (urllib.error.HTTPError, urllib.error.URLError, ValueError, json.JSONDecodeError) as e:
        print(f'AI analysis failed ({e}) -> keeping existing file.')
        return 0
    out['date'] = date
    out['source'] = 'ai'
    out['model'] = MODEL
    with open('data/ai_analysis.json', 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"Wrote data/ai_analysis.json for {date} — {out.get('headline', '')[:60]}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
