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
        headline = 'עלייה רחבה — השוק חזק מבפנים'
    elif weak:
        headline = 'חולשה — הלחץ נמשך'
    else:
        headline = 'שוק מעורב — ללא הכרעה ברורה'

    paras = []
    # 1 — index + breadth + selling pressure
    p1 = (f'המדד {"יציב" if strong else "חלש"} '
          f'(ציון משולב {C}, VIX {vix:.1f}), '
          f'אבל הרוחב {"חלש" if narrow else "רחב"}: '
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
        p3 += ' והחזיק את המדד' if lead_m['chg'] > 0.3 else ''
        if broken:
            p3 += f". {', '.join(x['s'] for x in broken)} כבר מתחת ל-MA50."
        else:
            p3 += '.'
        paras.append(p3)

    # 4 — options (concise: Flow + Δ + P/C)
    f_lbl = flow.get('directionLabel', '')
    p4 = f"אופציות: Flow {sc.get('flow')}"
    if f_lbl:
        p4 += f' ({f_lbl})'
    if flow_delta:
        p4 += f' · {flow_delta} מאתמול'
    if pc is not None:
        p4 += f' · P/C {pc:.2f}'
    paras.append(p4 + '.')

    # bottom line = state label + the concise action (avoids repeating the
    # breadth/selling-day facts already stated above).
    STATE_LABEL = {
        'confirmed_strength': 'מגמה בריאה', 'narrow_strength': 'עלייה לא-מאושרת',
        'chop': 'חוסר הכרעה', 'weak_stabilizing': 'חולשה מתייצבת',
        'weak_expanding': 'חולשה מתרחבת', 'acute': 'יום סיכון',
    }
    rec = concl.get('recommendation') or {}
    label = STATE_LABEL.get(concl.get('state'), '')
    action = rec.get('action', '')
    bottom = ' — '.join(x for x in (label, action) if x)
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
