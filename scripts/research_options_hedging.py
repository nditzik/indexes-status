#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
research_options_hedging.py — מחקר (12.9.2026, שלב 1): האם זרימת האופציות הגדולות
ב-SPX/SPY נושאת מידע כ"מד לחץ" — ולא כמצפן כיוון (שנפסל: ראו send_report.directional_read).

ארבעה מדדים לכל יום, מהקבצים הקיימים בלבד:
  1. hedge_z   — עוצמת גידור: פרמיית פוטים שנקנו (Ask), z מול 20 הימים הקודמים.
  2. put_sb    — מי מוכר את הביטוח: מכירת פוטים / קניית פוטים (Bid/Ask).
  3. iv_rv     — מחיר הפחד מול המציאות: IV משוקלל-פרמיה של פוטים שנקנו / תנודתיות
                 ממומשת 20 יום (מסגירות S&P), שניהם שנתיים.
  4. long_share— אופק הגידור: נתח הפוטים שנקנו עם 60+ יום לפקיעה.

בדיקות: תשואות S&P קדימה 5 ו-20 ימי מסחר לפי שלישונים · קורלציית דרגות (ספירמן) ·
הקדמה לימי מכירה מוסדית (is_selling_day של הדשבורד) בשלושת ימי המסחר הבאים.
קורא בלבד — לא כותב לשום קובץ של הדשבורד. פלט: טבלאות למסך + docs/research/….md
"""
import csv, glob, io, json, math, os, re, statistics as st, sys, urllib.request
from datetime import datetime, timezone, date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
sys.path.insert(0, os.path.join('.github', 'workflows'))

def num(v):
    try: return float(str(v).replace(',', '').replace('%', '').replace('+', ''))
    except Exception: return None

# ── S&P closes (Yahoo, 1y) ──────────────────────────────────────────────
res = json.loads(urllib.request.urlopen(urllib.request.Request(
    "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1y",
    headers={"User-Agent": "Mozilla/5.0"}), timeout=20).read())["chart"]["result"][0]
off = res["meta"]["gmtoffset"]
closes = {datetime.fromtimestamp(t + off, timezone.utc).date(): c
          for t, c in zip(res["timestamp"], res["indicators"]["quote"][0]["close"]) if c}
tdays = sorted(closes)
idx = {d: i for i, d in enumerate(tdays)}

def fwd(d, k):
    i = idx.get(d)
    return (closes[tdays[i + k]] / closes[d] - 1) * 100 if i is not None and i + k < len(tdays) else None

def realized_vol(d, n=20):
    i = idx.get(d)
    if i is None or i < n: return None
    rs = [math.log(closes[tdays[j]] / closes[tdays[j - 1]]) for j in range(i - n + 1, i + 1)]
    return st.pstdev(rs) * math.sqrt(252) * 100

# ── sell days from the dashboard's own definition ───────────────────────
_stdout = sys.stdout; sys.stdout = io.StringIO()
try:
    import send_report as sr
    sells = {d['date']: bool(sr.is_selling_day(d)) for d in sr.history_rich if d.get('date')}
finally:
    sys.stdout = _stdout
sell_dates = {date.fromisoformat(k) for k, v in sells.items() if v}
known_dates = {date.fromisoformat(k) for k in sells}
print(f"sell days known: {len(known_dates)} sessions, {len(sell_dates)} selling days")

def sell_next(d, k=3):
    """Was there a selling day within the next k trading sessions?"""
    i = idx.get(d)
    if i is None: return None
    nxt = tdays[i + 1:i + 1 + k]
    if not nxt or any(x not in known_dates for x in nxt): return None
    return any(x in sell_dates for x in nxt)

# ── per-day indicators from the flow files ──────────────────────────────
def day_metrics(path, d0):
    rows = [r for r in csv.DictReader(open(path, encoding='utf-8-sig')) if r.get('Type') in ('Put', 'Call')]
    putAsk = putBid = callAsk = callBid = tot = 0.0
    iv_w = iv_p = 0.0
    long_p = 0.0
    for r in rows:
        p = num(r.get('Premium')) or 0; tot += p
        side = (r.get('Side') or '').lower(); t = r['Type']
        dte = num(r.get('DTE'))
        if dte is None:
            try: dte = (datetime.strptime(r['Exp Date'], '%Y-%m-%d').date() - d0).days
            except Exception: dte = None
        if t == 'Put' and side == 'ask':
            putAsk += p
            iv = num(r.get('IV'))
            if iv: iv_w += iv * p; iv_p += p
            if dte is not None and dte >= 60: long_p += p
        elif t == 'Put' and side == 'bid': putBid += p
        elif t == 'Call' and side == 'ask': callAsk += p
        elif t == 'Call' and side == 'bid': callBid += p
    return {'putAsk': putAsk, 'putBid': putBid, 'callAsk': callAsk, 'callBid': callBid, 'total': tot,
            'iv_put': (iv_w / iv_p) if iv_p else None, 'long_share': (long_p / putAsk * 100) if putAsk else None}

def collect(prefix):
    out = []
    for f in sorted(glob.glob(f'data/{prefix}-options-flow-*.csv')):
        m = re.search(r'(\d{2})-(\d{2})-(\d{4})', f)
        d0 = date(int(m.group(3)), int(m.group(1)), int(m.group(2)))
        if d0 not in closes: continue
        out.append((d0, day_metrics(f, d0)))
    return out

def add_derived(days):
    for i, (d0, m) in enumerate(days):
        prev = [x[1]['putAsk'] for x in days[max(0, i - 20):i]]
        m['hedge_z'] = (m['putAsk'] - st.mean(prev)) / (st.pstdev(prev) or 1) if len(prev) >= 10 else None
        m['put_sb'] = (m['putBid'] / m['putAsk']) if m['putAsk'] else None
        rv = realized_vol(d0)
        m['iv_rv'] = (m['iv_put'] / rv) if (m['iv_put'] and rv) else None
        m['f5'], m['f20'], m['sell3'] = fwd(d0, 5), fwd(d0, 20), sell_next(d0, 3)
    return days

def spearman(xs, ys):
    n = len(xs)
    if n < 6: return None
    rx = {v: i for i, v in enumerate(sorted(xs))}; ry = {v: i for i, v in enumerate(sorted(ys))}
    dx = [rx[x] for x in xs]; dy = [ry[y] for y in ys]
    mx, my = st.mean(dx), st.mean(dy)
    cov = sum((a - mx) * (b - my) for a, b in zip(dx, dy))
    sx = math.sqrt(sum((a - mx) ** 2 for a in dx)); sy = math.sqrt(sum((b - my) ** 2 for b in dy))
    return cov / (sx * sy) if sx and sy else None

def terciles(days, key, target):
    pts = [(m[key], m[target]) for _, m in days if m.get(key) is not None and m.get(target) is not None]
    if len(pts) < 9: return None
    pts.sort(key=lambda x: x[0]); n = len(pts); k = n // 3
    lo, mid, hi = pts[:k], pts[k:n - k], pts[n - k:]
    def desc(g):
        ys = [y for _, y in g]
        if isinstance(ys[0], bool): return f"{sum(ys) / len(ys) * 100:.0f}% (n={len(ys)})"
        return f"{st.mean(ys):+.2f}% ({sum(y > 0 for y in ys) / len(ys) * 100:.0f}% up, n={len(ys)})"
    rho = spearman([x for x, _ in pts], [float(y) for _, y in pts])
    return desc(lo), desc(mid), desc(hi), rho

def report(days, label, out):
    out.append(f"\n## {label} — {len(days)} ימים ({days[0][0]} → {days[-1][0]})\n")
    base5 = [m['f5'] for _, m in days if m['f5'] is not None]; base20 = [m['f20'] for _, m in days if m['f20'] is not None]
    bsell = [m['sell3'] for _, m in days if m['sell3'] is not None]
    out.append(f"בסיס (בלי אות): 5 ימים {st.mean(base5):+.2f}% ({sum(x > 0 for x in base5) / len(base5) * 100:.0f}% up) · 20 ימים {st.mean(base20):+.2f}% ({sum(x > 0 for x in base20) / len(base20) * 100:.0f}% up) · יום מכירה ב-3 הימים הבאים: {sum(bsell) / len(bsell) * 100:.0f}%\n")
    out.append("| מדד | יעד | שלישון נמוך | אמצע | שלישון גבוה | ספירמן |\n|---|---|---|---|---|---|")
    for key, name in (('hedge_z', 'עוצמת גידור (z)'), ('put_sb', 'מכירת/קניית פוטים'), ('iv_rv', 'IV פוטים / תנודתיות בפועל'), ('long_share', 'נתח גידור 60+ יום')):
        for target, tname in (('f5', 'S&P 5 ימים'), ('f20', 'S&P 20 ימים'), ('sell3', 'יום מכירה ב-3 ימים')):
            r = terciles(days, key, target)
            if r: out.append(f"| {name} | {tname} | {r[0]} | {r[1]} | {r[2]} | {r[3]:+.2f} |" if r[3] is not None else f"| {name} | {tname} | {r[0]} | {r[1]} | {r[2]} | — |")
    vals = {k: [m[k] for _, m in days if m.get(k) is not None] for k in ('put_sb', 'iv_rv', 'long_share')}
    out.append(f"\nטווחים: מכירה/קנייה פוטים חציון {st.median(vals['put_sb']):.2f} · IV/RV חציון {st.median(vals['iv_rv']):.2f} (מינ' {min(vals['iv_rv']):.2f}, מקס' {max(vals['iv_rv']):.2f}) · נתח 60+ יום חציון {st.median(vals['long_share']):.0f}%")

def main():
    out = ["# מחקר: זרימת אופציות כמד לחץ (שלב 1)\n", f"נוצר: {datetime.now().strftime('%d/%m/%Y %H:%M')} · סקריפט: scripts/research_options_hedging.py · קריאה בלבד\n",
           "שאלה: האם ארבעה מדדי 'גידור' מהעסקאות הגדולות מקדימים תשואות S&P (5/20 ימי מסחר) או ימי מכירה מוסדית — אחרי שקריאת הכיוון עצמה נפסלה.\n"]
    spx = add_derived(collect('spx'))
    report(spx, 'SPX', out)
    spy = collect('spy')
    if len(spy) >= 5:
        spy = add_derived(spy)
        out.append(f"\n## SPY — {len(spy)} ימים בלבד (אין עדיין מספיק להסקה; לתיעוד)\n")
        for d0, m in spy:
            out.append(f"- {d0}: פוטים נקנו ${m['putAsk'] / 1e6:.0f}M · מכירה/קנייה {m['put_sb']:.2f} · IV/RV {m['iv_rv']:.2f} · 60+ יום {m['long_share']:.0f}% → 5 ימים {'' if m['f5'] is None else f'{m['f5']:+.2f}%'}")
    text = "\n".join(out)
    print(text)
    os.makedirs('docs/research', exist_ok=True)
    with open('docs/research/options-hedging-phase1.md', 'w', encoding='utf-8') as f:
        f.write(text + "\n")
    print("\n[saved] docs/research/options-hedging-phase1.md")

if __name__ == '__main__':
    main()
