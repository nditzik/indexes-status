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
from collections import Counter, defaultdict

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
    rot = state.get('rotation') or {}
    rot_light = ((state.get('verdict') or {}).get('lights') or {}).get('rotation')
    lead_names = ' · '.join(names.get(c, c) for c in rot.get('leadingSectors', []))
    cyc, dfn = rot.get('cyclicalLeading', 0), rot.get('defensiveLeading', 0)

    # Headline = a factual read of the day (no over-claim; the integrated
    # block carries the nuance, so they never contradict).
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

    # ── Block 1: מניות (טכני) ──
    breadth_clause = 'אבל הרוחב חלש' if narrow else 'והרוחב רחב'
    l_breadth = (f'המדד {"יציב" if strong else "חלש"} (ציון משולב {C}, VIX {vix:.1f}), '
                 f'{breadth_clause}: {down} מניות ירדו מול {up} שעלו, {below} מתחת ל-MA50.')
    if dist_days:
        l_breadth += f' לחץ מכירות מצטבר: {dist_days} ימי מכירה ב-25.'
    lag_txt = ', '.join(f"{x['s']} {_pct(x['chg'])}" for x in laggards)
    lead_txt = ', '.join(f"{x['s']} {_pct(x['chg'])}" for x in leaders)
    l_movers = f'מובילים: {lead_txt}. מפגרים: {lag_txt}.'
    mega = [x for x in stocks if x['s'] in MEGA]
    broken = [x for x in mega if not x['aboveMa50']]
    l_mega = ''
    if mega:
        lm = max(mega, key=lambda x: x['chg'])
        l_mega = f"בגדולות, {lm['s']} ({_pct(lm['chg'])}) הוביל"
        l_mega += ' והחזיק את המדד' if (lm['chg'] > 0.3 and narrow) else ''
        l_mega += (f". {', '.join(x['s'] for x in broken)} מתחת ל-MA50." if broken else '.')

    # ── Block 2: סקטורים ──
    sec_today = defaultdict(list)
    for x in stocks:
        if x['sec']:
            sec_today[x['sec']].append(x['chg'])
    sec_avg = sorted(((s, sum(v)/len(v)) for s, v in sec_today.items() if len(v) >= 3),
                     key=lambda t: -t[1])
    l_sectors = ''
    if sec_avg:
        top = ' · '.join(f'{s} {avg:+.1f}%' for s, avg in sec_avg[:3])
        bot = ' · '.join(f'{s} {avg:+.1f}%' for s, avg in sec_avg[-2:][::-1])
        l_sectors = f'היום הובילו: {top}. פיגרו: {bot}.'
    if lead_names:
        rtype = 'מחזורית (סיכון-on)' if cyc > dfn else 'הגנתית (סיכון-off)' if dfn > cyc else 'מעורבת'
        l_rotation = f'מנהיגות מתמשכת (RS 5+20 יום): {lead_names} — {rtype}.'
    else:
        l_rotation = 'אין מנהיגות סקטוריאלית מתמשכת (אף סקטור לא מנצח את המדד ב-5 וב-20 יום).'
    lag_sec, lead_sec = dom_sector(laggards), dom_sector(leaders)
    if lag_sec and lead_sec and lag_sec != lead_sec:
        l_rotation += f' היום: רוטציה מ{lag_sec} לעבר {lead_sec}.'

    # ── Block 3: אופציות (delta-weighted) ──
    dlabel = flow.get('deltaLabel') or ''
    cb, cs = flow.get('callBuyP') or 0, flow.get('callSellP') or 0
    pb, ps = flow.get('putBuyP') or 0, flow.get('putSellP') or 0
    bull_act, bear_act = cb + ps, pb + cs
    l_opt = f'הכסף הגדול נטו <b>{dlabel}</b> (משוקלל-דלתא)'
    if bear_act > bull_act and (pb or cs):
        l_opt += f' — פעולות דוביות דומיננטיות: קניית puts ${pb/1e6:.0f}M + מכירת calls ${cs/1e6:.0f}M'
    elif bull_act > bear_act and (cb or ps):
        l_opt += f' — פעולות שוריות דומיננטיות: קניית calls ${cb/1e6:.0f}M + מכירת puts ${ps/1e6:.0f}M'
    olean = flow.get('openingLean')
    if olean and olean != 'מאוזן':
        l_opt += f'. פוזיציות חדשות (ToOpen) נוטות {olean} — מדגם קטן'
    tail = f"Flow {sc.get('flow')}"
    if flow_delta:
        tail += f' ({flow_delta})'
    if pc is not None:
        tail += f' · P/C {pc:.2f}'
    l_opt += f'. {tail}.'

    # ── Block 4: התמונה המשולבת — do the three domains agree? ──
    stocks_sig = 'bull' if up > down * 1.15 else 'bear' if down > up * 1.15 else 'mixed'
    sectors_sig = 'bull' if rot_light == 'pos' else 'bear' if rot_light == 'neg' else 'mixed'
    options_sig = {'שורי': 'bull', 'דובי': 'bear', 'מאוזן': 'mixed'}.get(dlabel, 'mixed')
    _he = {'bull': 'חיובי', 'bear': 'שלילי', 'mixed': 'מעורב'}
    trio = f'מניות {_he[stocks_sig]} · סקטורים {_he[sectors_sig]} · אופציות {_he[options_sig]}.'
    if stocks_sig == options_sig == sectors_sig and stocks_sig != 'mixed':
        synth = f'שלושת המקורות מסכימים ({_he[stocks_sig]}) — תמונה קוהרנטית.'
    elif stocks_sig == 'bull' and options_sig == 'bear':
        synth = 'המחיר חזק אבל הכסף הגדול באופציות דובי — עלייה שאינה מאושרת מבפנים.'
    elif stocks_sig == 'bear' and options_sig == 'bull':
        synth = 'המחיר חלש אבל האופציות שוריות — ייתכן ניצול ירידה ע"י הכסף הגדול.'
    elif sectors_sig == 'bear' and stocks_sig != 'bear':
        synth = 'המחיר מחזיק אבל המנהיגות הסקטוריאלית מתגוננת — חוזק שלא מאושר ברוחב.'
    else:
        synth = 'תמונה מעורבת — הסיגנלים אינם מיושרים, אין הכרעה ברורה.'
    rec = concl.get('recommendation') or {}
    action = rec.get('action', '')

    blocks = [
        {'title': '📈 מניות (טכני)', 'lines': [l for l in (l_breadth, l_movers, l_mega) if l]},
        {'title': '🔄 סקטורים', 'lines': [l for l in (l_sectors, l_rotation) if l]},
        {'title': '🎯 אופציות', 'lines': [l_opt]},
        {'title': '🧩 התמונה המשולבת',
         'lines': [f'{trio} {synth}'] + ([f'המלצה: {action}'] if action else [])},
    ]

    watch_bits = []
    if rec.get('improve'):
        watch_bits.append(f"שיפור: {rec['improve']}")
    if rec.get('worsen'):
        watch_bits.append(f"הרעה: {rec['worsen']}")

    conf_map = {'high': 'גבוה', 'medium': 'בינוני', 'low': 'נמוך'}
    return {
        'date': state.get('date'),
        'headline': headline,
        'blocks': blocks,
        # Flat paragraphs kept as a fallback for any consumer that doesn't
        # render blocks (e.g. a future email).
        'paragraphs': [ln for b in blocks for ln in b['lines']],
        'watchFor': ' · '.join(watch_bits),
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
