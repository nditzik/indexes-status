#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_big_trades.py — "הכסף הגדול היום" (13.9.2026): מהייצוא של Barchart "Options Flow"
(500 העסקאות הגדולות של היום בכל שוק המניות, data/options-flow-MM-DD-YYYY.csv)
אל data/big_trades.json — חמש הפוזיציות הבולטות במניות בודדות, מנוקות ומוסברות.

למה ניקוי: הקובץ הגולמי הוא "מי עשה עסקה ענקית" — 87% מהפרמיה בלי צד (Mid), פוזיציה
אחת מודפסת בעשרות פרוסות (UNH 11.9: 134 הדפסות באותן 10 דקות), וקולים עמוקים בכסף
לפקיעה קרובה הם ארביטראז'/תחליף מניה ולא הימור. לכן:
  1. מאחדים הדפסות לפוזיציות: מניה + סוג + פקיעה (+ חלון זמן של 15 דק').
  2. זורקים פקיעות של אותו יום (0DTE) — ריצות תוך-יומיות, לא פוזיציות.
  3. מסווגים כל פוזיציה: 'new' (ToOpen או נפח > פוזיציות פתוחות ברוב הפרמיה) /
     'roll' (אותה מניה ואותו סוג בשתי פקיעות, אחת נסגרת ואחת נפתחת) /
     'synthetic' (|דלתא| ממוצעת > 0.85 — תחליף מניה/ארביטראז', לא כיוון) /
     'combo' (קול ופוט באותה פקיעה ובאותו זמן) / 'flow' (אחר).
  4. כיוון: מהצד אם יש (ask=קנייה, bid=מכירה), אחרת מהסוג בהנחת קנייה — ומסומן 'מוערך'.
  5. חמש המניות לפי פרמיה, עם משפט עברי אחד לכל אחת. 'synthetic' נשאר ברשימה אבל
     מסומן במפורש "לא הימור כיווני" — כדי שהקורא ילמד להבדיל, לא כדי להסתיר.

קריאה בלבד מקבצי data/. פלט: data/big_trades.json {date, items:[...], _meta}.
"""
import csv, glob, json, os, re, sys
from collections import defaultdict, Counter
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
OUT = os.path.join('data', 'big_trades.json')
DATE_RE = re.compile(r'options-flow-(\d{2})-(\d{2})-(\d{4})\.csv$')
TOP_N = 5
WINDOW_MIN = 15


def num(v):
    try:
        return float(str(v).replace(',', '').replace('%', '').replace('+', ''))
    except Exception:
        return None


def fmt_m(v):
    return f"{v / 1e9:.1f} מיליארד" if v >= 1e9 else f"{v / 1e6:.0f} מיליון"


def he_date(iso):
    y, m, d = iso.split('-')
    return f"{int(d)}.{int(m)}.{y[2:]}"


def latest_file():
    files = glob.glob('data/options-flow-*.csv')
    files = [f for f in files if DATE_RE.search(os.path.basename(f))]
    if not files:
        return None
    return max(files, key=lambda f: (lambda m: (m.group(3), m.group(1), m.group(2)))(DATE_RE.search(os.path.basename(f))))


def load(path):
    rows = [r for r in csv.DictReader(open(path, encoding='utf-8-sig', newline='')) if r.get('Type') in ('Put', 'Call')]
    for r in rows:
        r['_p'] = num(r.get('Premium')) or 0.0
        r['_d'] = num(r.get('Delta')) or 0.0
        r['_dte'] = num(r.get('DTE'))
        r['_vol'] = num(r.get('Volume')) or 0.0
        r['_oi'] = num(r.get('Open Int')) or 0.0
        r['_side'] = (r.get('Side') or '').strip().lower()
        r['_flag'] = (r.get('*') or '').strip()
        t = (r.get('Time') or '').strip()
        try:
            hh, mm = t.split(':')[0:2]
            r['_min'] = int(hh) * 60 + int(mm)
        except Exception:
            r['_min'] = None
    return rows


def positions(rows):
    """הדפסות → פוזיציות: (symbol, type, expiry) ובתוכן חלונות זמן של WINDOW_MIN."""
    groups = defaultdict(list)
    for r in rows:
        if r['_dte'] is not None and r['_dte'] <= 0:
            continue                      # 0DTE — לא פוזיציה
        groups[(r['Symbol'], r['Type'], r['Exp Date'])].append(r)
    out = []
    for (sym, typ, exp), rs in groups.items():
        rs.sort(key=lambda r: (r['_min'] if r['_min'] is not None else 10 ** 6))
        cur, start = [], None
        for r in rs:
            if cur and r['_min'] is not None and start is not None and r['_min'] - start > WINDOW_MIN:
                out.append(_pos(sym, typ, exp, cur)); cur, start = [], None
            if not cur:
                start = r['_min']
            cur.append(r)
        if cur:
            out.append(_pos(sym, typ, exp, cur))
    return out


def _pos(sym, typ, exp, rs):
    p = sum(r['_p'] for r in rs)
    w = lambda k: sum(r[k] * r['_p'] for r in rs) / p if p else 0
    strikes = sorted({num(r['Strike']) for r in rs if num(r['Strike']) is not None})
    ask = sum(r['_p'] for r in rs if r['_side'] == 'ask'); bid = sum(r['_p'] for r in rs if r['_side'] == 'bid')
    newp = sum(r['_p'] for r in rs if r['_vol'] > r['_oi'] or 'open' in r['_flag'].lower())
    return {
        'symbol': sym, 'type': typ, 'exp': exp, 'prints': len(rs), 'premium': p,
        'dte': rs[0]['_dte'], 'strikes': (strikes[0], strikes[-1]) if strikes else (None, None),
        'absDelta': abs(w('_d')), 'askP': ask, 'bidP': bid, 'newShare': newp / p if p else 0,
        'toOpen': sum('open' in r['_flag'].lower() for r in rs),
        'sellToOpen': sum('sell' in r['_flag'].lower() for r in rs),
        'price': num(rs[0].get('Price~')), 'tmin': rs[0]['_min'],
        'codes': Counter(r.get('Code', '') for r in rs),
    }


def classify_symbol(sym, ps):
    """מספר פוזיציות של אותה מניה → סיפור אחד. הסיווג נעשה לפי רגל (פוזיציה), לא לפי
    המניה כולה: רגל עם |דלתא| ≥ 0.85 היא תחליף מניה/ארביטראז'; השאר כיווניות.
    רגל-הכותרת = הכיוונית הגדולה אם הכיווניות הן ≥ 25% מהפרמיה, אחרת הגדולה בכלל."""
    total = sum(x['premium'] for x in ps)
    syn = [x for x in ps if x['absDelta'] >= 0.85]
    dirs = [x for x in ps if x['absDelta'] < 0.85]
    dir_total = sum(x['premium'] for x in dirs)
    syn_total = total - dir_total
    if dirs and dir_total >= 0.25 * total:
        top = max(dirs, key=lambda x: x['premium'])
        pool = dirs
        types = {x['type'] for x in pool}; exps = sorted({x['exp'] for x in pool})
        new_share = sum(x['newShare'] * x['premium'] for x in pool) / dir_total
        if len(types) == 2 and len(exps) == 1:
            kind = 'combo'
        elif len(types) == 1 and len(exps) >= 2 and any(x['sellToOpen'] or x['bidP'] > x['askP'] for x in pool) and any(x['toOpen'] or x['askP'] > x['bidP'] for x in pool):
            kind = 'roll'
        elif new_share >= 0.5:
            kind = 'new'
        else:
            kind = 'flow'
        askP = sum(x['askP'] for x in pool); bidP = sum(x['bidP'] for x in pool)
        if askP + bidP >= 0.25 * dir_total:
            est = False
            # הכיוון מרגל-הכותרת כשיש לה צד (אחרת המשפט "מכירת קולים … נטייה למעלה" סותר
            # את עצמו — קרה ב-GOOGL 14.9); כשאין לה צד — מכל הרגליים הכיווניות יחד.
            src = [top] if (top['askP'] + top['bidP']) > 0 else pool
            net = sum((1 if x['type'] == 'Call' else -1) * (x['askP'] - x['bidP']) for x in src)
            direction = 'up' if net > 0 else 'down' if net < 0 else 'flat'
        else:
            est = True
            calls = sum(x['premium'] for x in pool if x['type'] == 'Call')
            direction = 'up' if calls > dir_total - calls else 'down'
    else:
        top = max(ps, key=lambda x: x['premium'])
        kind, direction, est, exps = 'synthetic', 'none', True, sorted({x['exp'] for x in syn or ps})
    return {
        'symbol': sym, 'premium': total, 'dirPremium': dir_total, 'synPremium': syn_total,
        'kind': kind, 'direction': direction, 'directionEstimated': est,
        'price': top['price'], 'exps': exps, 'prints': sum(x['prints'] for x in ps),
        'topLeg': top, 'positions': len(ps),
    }


KIND_HE = {
    'new': 'פוזיציה חדשה', 'roll': 'גלגול פוזיציה', 'synthetic': "תחליף מניה / ארביטראז'",
    'combo': 'מבנה משולב (קול+פוט)', 'flow': 'זרימה',
}


def sentence(it):
    leg = it['topLeg']
    lo, hi = leg['strikes']
    strikes = f"סטרייק {lo:g}" if lo == hi else f"סטרייקים {lo:g}–{hi:g}"
    exp = he_date(leg['exp'])
    typ = 'קולים' if leg['type'] == 'Call' else 'פוטים'
    if it['kind'] == 'synthetic':
        s = (f"{fmt_m(it['synPremium'] or it['premium'])} דולר ב{typ} עמוקים בכסף ({strikes}, פקיעה {exp}), {it['prints']} הדפסות — "
             f"תחליף מניה או ארביטראז', לא הימור כיווני.")
        if it['dirPremium'] >= 5e6:
            s += f" לצד זה {fmt_m(it['dirPremium'])} בפוזיציות קטנות יותר."
        return s
    money = fmt_m(leg['premium'])
    dir_he = {'up': 'למעלה', 'down': 'למטה', 'flat': 'מאוזן'}[it['direction']]
    est = ' (מוערך מסוג האופציה)' if it['directionEstimated'] else ''
    if not it['directionEstimated'] and leg['askP'] + leg['bidP'] > 0:
        typ = ('מכירת ' if leg['bidP'] > leg['askP'] else 'קניית ') + typ
    if it['kind'] == 'new':
        s = f"{money} דולר ב{typ} {strikes}, פקיעה {exp} — פוזיציה חדשה, הימור {dir_he}{est}."
    elif it['kind'] == 'roll':
        s = f"{money} דולר ב{typ} על פני {len(it['exps'])} פקיעות ({he_date(it['exps'][0])} → {he_date(it['exps'][-1])}) — גלגול פוזיציה קיימת, נטייה {dir_he}{est}."
    elif it['kind'] == 'combo':
        s = f"{money} דולר במבנה קול+פוט לפקיעה {exp} — אסטרטגיה משולבת, נטייה {dir_he}{est}."
    else:
        s = f"{money} דולר ב{typ} {strikes}, פקיעה {exp} — נטייה {dir_he}{est}."
    if it['synPremium'] >= 0.3 * it['premium']:
        s += f" בנוסף {fmt_m(it['synPremium'])} בתחליפי מניה (לא כיווני)."
    return s


def main():
    path = latest_file()
    if not path:
        print('[skip] אין קובץ options-flow-*.csv'); return 0
    m = DATE_RE.search(os.path.basename(path)); iso = f"{m.group(3)}-{m.group(1)}-{m.group(2)}"
    rows = load(path)
    total = sum(r['_p'] for r in rows)
    ps = positions(rows)
    by_sym = defaultdict(list)
    for x in ps:
        by_sym[x['symbol']].append(x)
    items = [classify_symbol(s, v) for s, v in by_sym.items()]
    items.sort(key=lambda x: -x['premium'])
    top = items[:TOP_N]
    out = {
        'date': iso, 'label': he_date(iso), 'totalPremium': round(total), 'symbols': len(by_sym), 'prints': len(rows),
        'items': [{
            'ticker': it['symbol'], 'premium': round(it['premium']), 'kind': it['kind'], 'kindHe': KIND_HE[it['kind']],
            'direction': it['direction'], 'estimated': it['directionEstimated'], 'price': it['price'],
            'dirPremium': round(it['dirPremium']), 'synPremium': round(it['synPremium']),
            'exps': it['exps'], 'prints': it['prints'], 'text': sentence(it),
        } for it in top],
        'note': 'מ-500 העסקאות הגדולות של היום (Barchart Options Flow) אחרי איחוד הדפסות והשמטת 0DTE · הכיוון מוערך כשאין צד לעסקה',
        '_meta': {'source': os.path.basename(path), 'updatedAt': (datetime.now(timezone.utc) + timedelta(hours=3)).strftime('%d/%m/%Y %H:%M')},
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"[done] {iso}: {len(rows)} prints → {len(ps)} positions → {len(by_sym)} symbols · top {TOP_N}:")
    for it in out['items']:
        print(f"  {it['ticker']:6s} {it['kindHe']:<24s} {it['direction']:<5s} {it['text']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
