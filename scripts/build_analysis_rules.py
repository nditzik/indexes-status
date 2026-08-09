"""
build_analysis_rules.py — the FREE, rule-based daily analyst note.

Composes a specific, data-driven analysis (data/ai_analysis.json) with NO
API and NO key: names the actual leaders/laggards and their sectors,
detects rotation (which sector leads vs lags), checks the mega-caps, sums
the month's selling pressure, and summarizes the options flow — then a
data-driven bottom line + triggers. Runs every day in CI for free.

It runs BEFORE build_ai_analysis.py, so if an ANTHROPIC_API_KEY is later
added the Claude note upgrades this one; without a key, this is the note.
Everything is derived from the numbers — the content changes daily.
"""
import csv
import glob
import io
import json
import re
from collections import Counter

WL_RE = re.compile(r'watchlist-sp-500-intraday-(\d{2})-(\d{2})-(\d{4})\.csv$')
FL_RE = re.compile(r'spx-options-flow-(\d{2})-(\d{2})-(\d{4})\.csv$')
MEGA = ['NVDA', 'MSFT', 'AAPL', 'GOOGL', 'AMZN', 'META', 'AVGO', 'TSLA']


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


def _load(path, default):
    try:
        return json.load(open(path, encoding='utf-8'))
    except Exception:
        return default


def _pct(v):
    return f'{v:+.1f}%'


def build():
    state = _load('data/daily_state.json', {})
    sm = _load('data/sectors.json', {})
    tickers, names = sm.get('tickers', {}), sm.get('codes', {})
    sc = state.get('scores', {})
    concl = state.get('conclusion') or {}
    flow = state.get('flow') or {}
    ev = state.get('evidence') or {}
    risk = state.get('riskOff') or {}
    C = sc.get('combined')
    vix = ev.get('vix')

    # ── stocks from the latest watchlist ──
    wl = _latest('data/watchlist-sp-500-intraday-*.csv', WL_RE)
    stocks = []
    if wl:
        for r in csv.DictReader(io.StringIO(open(wl, encoding='utf-8-sig').read())):
            s = (r.get('Symbol') or '').strip()
            if not s or s.startswith('$') or s == 'RSP':
                continue
            chg, latest, ma50 = _num(r.get('%Change')), _num(r.get('Latest')), _num(r.get('50D MA'))
            if chg is None or abs(chg) >= 50:
                continue
            stocks.append({'s': s, 'chg': chg,
                           'aboveMa50': bool(ma50 and latest and latest > ma50),
                           'sec': names.get(tickers.get(s), None)})
    stocks.sort(key=lambda x: -x['chg'])
    up = sum(1 for x in stocks if x['chg'] > 0)
    down = sum(1 for x in stocks if x['chg'] < 0)
    below = sum(1 for x in stocks if not x['aboveMa50'])
    leaders, laggards = stocks[:3], stocks[-3:][::-1]

    def dom_sector(rows):
        c = Counter(x['sec'] for x in rows if x['sec'])
        return c.most_common(1)[0][0] if c else None

    # ── options: Flow + Δ vs prior + P/C premium ──
    fl = _latest('data/spx-options-flow-*.csv', FL_RE)
    callP = putP = 0.0
    if fl:
        for r in csv.DictReader(io.StringIO(open(fl, encoding='utf-8-sig').read())):
            prem = _num(r.get('Premium')) or 0
            t = (r.get('Type') or '').strip().lower()
            if t == 'call':  callP += prem
            elif t == 'put': putP += prem
    pc = (putP / callP) if callP else None
    flow_delta = next((c for c in (concl.get('change') or []) if c.startswith('Flow')), '')

    # ── selling pressure (this month) ──
    dist_days = len(risk.get('sellingDays') or [])

    # ══ compose ══
    strong = C is not None and C >= 60
    weak = C is not None and C < 45
    narrow = down > up

    if risk.get('acute'):
        headline = 'יום סיכון — אירוע מכירה חד'
    elif strong and narrow:
        headline = 'עלייה צרה — המדד מחזיק, אבל הרוב יורד'
    elif strong:
        headline = 'יום עלייה רחב'
    elif weak:
        headline = 'חולשה — הלחץ נמשך'
    else:
        headline = 'שוק מעורב — ללא הכרעה ברורה'

    paras = []
    # 1 — index + breadth + selling pressure
    breadth_clause = 'אבל הרוחב חלש' if narrow else 'והרוחב רחב'
    p1 = (f'המדד {"יציב" if strong else "חלש"} '
          f'(ציון משולב {C}, VIX {vix:.1f}), {breadth_clause}: '
          f'{down} מניות ירדו מול {up} שעלו, {below} מתחת ל-MA50.')
    if dist_days:
        p1 += f' לחץ מכירות מצטבר: {dist_days} ימי מכירה ב-25 הימים האחרונים.'
    paras.append(p1)

    # 2 — laggards / leaders by name + rotation insight
    lag_sec, lead_sec = dom_sector(laggards), dom_sector(leaders)
    lag_txt = ', '.join(f"{x['s']} {_pct(x['chg'])}" for x in laggards)
    lead_txt = ', '.join(f"{x['s']} {_pct(x['chg'])}" for x in leaders)
    p2 = (f'המפגרים{f" בעיקר ב{lag_sec}" if lag_sec else ""}: {lag_txt}. '
          f'המובילים{f" ב{lead_sec}" if lead_sec else ""}: {lead_txt}.')
    if lag_sec and lead_sec and lag_sec != lead_sec:
        p2 += f' רוטציה מ{lag_sec} לעבר {lead_sec}.'
    paras.append(p2)

    # 3 — mega-caps
    mega = [x for x in stocks if x['s'] in MEGA]
    up_mega = [x for x in mega if x['chg'] > 0.3]
    broken = [x for x in mega if not x['aboveMa50']]
    if mega:
        lead_m = max(mega, key=lambda x: x['chg'])
        p3 = f"בגדולות, {lead_m['s']} ({_pct(lead_m['chg'])}) הוביל"
        # "held the index" only makes sense on a NARROW day; on a broad day
        # no single mega-cap is carrying it.
        p3 += ' והחזיק את המדד' if (lead_m['chg'] > 0.3 and narrow) else ''
        if broken:
            p3 += f". {', '.join(x['s'] for x in broken)} כבר מתחת ל-MA50."
        else:
            p3 += '.'
        paras.append(p3)

    # 4 — options: lead with the DELTA-WEIGHTED net bet (the real read),
    # then the quadrant story (buy puts + sell calls = bearish), then
    # Flow/P/C as secondary context.
    dlabel = flow.get('deltaLabel') or ''
    cb = flow.get('callBuyP') or 0
    cs = flow.get('callSellP') or 0
    pb = flow.get('putBuyP') or 0
    ps = flow.get('putSellP') or 0
    bull_act, bear_act = cb + ps, pb + cs   # buy-calls+sell-puts vs buy-puts+sell-calls
    p4 = f'אופציות: הכסף הגדול נטו <b>{dlabel}</b> (משוקלל-דלתא)'
    if bear_act > bull_act and (pb or cs):
        p4 += f' — פעולות דוביות דומיננטיות: קניית puts ${pb/1e6:.0f}M + מכירת calls ${cs/1e6:.0f}M'
    elif bull_act > bear_act and (cb or ps):
        p4 += f' — פעולות שוריות דומיננטיות: קניית calls ${cb/1e6:.0f}M + מכירת puts ${ps/1e6:.0f}M'
    olean = flow.get('openingLean')
    if olean and olean != 'מאוזן':
        p4 += f'. פוזיציות חדשות (ToOpen) נוטות {olean} — מדגם קטן'
    tail = f"Flow {sc.get('flow')}"
    if flow_delta:
        tail += f' ({flow_delta})'
    if pc is not None:
        tail += f' · P/C {pc:.2f}'
    paras.append(p4 + f'. {tail}.')

    # Bottom line = the actionable stance only. (A state LABEL like
    # 'unconfirmed/narrow' can contradict a broad up-day, so we use just the
    # action here; full headline↔state coherence is the blocks step.)
    rec = concl.get('recommendation') or {}
    bottom = rec.get('action', '')
    watch_bits = []
    if rec.get('improve'):
        watch_bits.append(f"שיפור: {rec['improve']}")
    if rec.get('worsen'):
        watch_bits.append(f"הרעה: {rec['worsen']}")
    watch = ' · '.join(watch_bits)

    conf_map = {'high': 'גבוה', 'medium': 'בינוני', 'low': 'נמוך'}
    return {
        'date': state.get('date'),
        'headline': headline,
        'paragraphs': paras + ([f'שורה תחתונה: {bottom}'] if bottom else []),
        'watchFor': watch,
        'confidence': conf_map.get(concl.get('conviction'), 'בינוני'),
        'source': 'rules',
    }


def main():
    out = build()
    with open('data/ai_analysis.json', 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"Wrote data/ai_analysis.json (rules) for {out['date']} — {out['headline']}")


if __name__ == '__main__':
    main()
