#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
research_vol_regimes.py — מחקר שלב 2 (12.9.2026): איך "מד לחץ" מאופציות מתנהג בשוק דובי.

אין לנו היסטוריית ייצוא Barchart לפני אפריל 2026, ו-CBOE חוסמת את קובצי יחס
פוט/קול. לכן משתמשים בפרוקסי ציבוריים עם היסטוריה מ-2008 (Yahoo):
  • VIX / תנודתיות ממומשת 20 יום   ≈ "מחיר הפחד מול המציאות" (iv_rv שלנו)
  • VIX / VIX6M (מבנה עקום)         ≈ לחץ קצר-טווח מול ארוך (מעל 1 = היפוך = סטרס)
  • SKEW (z מול 60 יום)              ≈ ביקוש לביטוח זנב = "עוצמת גידור ארוך"
  • VVIX                             ≈ תנודתיות של הפחד עצמו
לכל יום: תשואת S&P קדימה 5/20/60 ימי מסחר, ומקסימום ירידה ב-60 יום.
מחלקים לשלישונים ובודקים בנפרד: כל התקופה · שנות דוב (2008, 2011H2, 2015H2–16H1,
2018Q4, 2020Q1, 2022) · שנות שור.
קלט: קובץ vol_hist.json (מהסקראצ'פד או --hist <path>). קריאה בלבד.
"""
import json, math, os, statistics as st, sys
from datetime import date

hist_path = sys.argv[sys.argv.index('--hist') + 1] if '--hist' in sys.argv else 'vol_hist.json'
H = json.load(open(hist_path))
spx = {date.fromisoformat(k): v for k, v in H['^GSPC'].items()}
vix = {date.fromisoformat(k): v for k, v in H['^VIX'].items()}
v6 = {date.fromisoformat(k): v for k, v in H.get('^VIX6M', {}).items()}
skew = {date.fromisoformat(k): v for k, v in H.get('^SKEW', {}).items()}
days = sorted(d for d in spx if d in vix)
idx = {d: i for i, d in enumerate(days)}

BEAR = [(date(2008, 1, 1), date(2009, 3, 9)), (date(2011, 7, 22), date(2011, 10, 3)), (date(2015, 8, 1), date(2016, 2, 11)),
        (date(2018, 10, 1), date(2018, 12, 24)), (date(2020, 2, 19), date(2020, 3, 23)), (date(2022, 1, 3), date(2022, 10, 12))]
def in_bear(d): return any(a <= d <= b for a, b in BEAR)

def fwd(i, k):
    return (spx[days[i + k]] / spx[days[i]] - 1) * 100 if i + k < len(days) else None
def maxdd(i, k):
    if i + k >= len(days): return None
    p0 = spx[days[i]]; lo = min(spx[days[j]] for j in range(i + 1, i + k + 1))
    return (lo / p0 - 1) * 100

rows = []
for i, d in enumerate(days):
    if i < 60: continue
    rs = [math.log(spx[days[j]] / spx[days[j - 1]]) for j in range(i - 19, i + 1)]
    rv = st.pstdev(rs) * math.sqrt(252) * 100
    m = {'d': d, 'vix_rv': vix[d] / rv if rv else None,
         'term': (vix[d] / v6[d]) if d in v6 and v6[d] else None}
    sk = [skew[days[j]] for j in range(i - 59, i + 1) if days[j] in skew]
    m['skew_z'] = ((skew[d] - st.mean(sk)) / (st.pstdev(sk) or 1)) if d in skew and len(sk) >= 40 else None
    m['f5'], m['f20'], m['f60'], m['dd60'] = fwd(i, 5), fwd(i, 20), fwd(i, 60), maxdd(i, 60)
    m['bear'] = in_bear(d)
    rows.append(m)

def tercile_table(sub, key, out, label):
    pts = [m for m in sub if m.get(key) is not None and m.get('f20') is not None]
    if len(pts) < 30:
        out.append(f"| {label} | n={len(pts)} (מעט מדי) | | | |"); return
    pts.sort(key=lambda m: m[key]); k = len(pts) // 3
    def desc(g):
        f20 = [m['f20'] for m in g]; f60 = [m['f60'] for m in g if m['f60'] is not None]; dd = [m['dd60'] for m in g if m['dd60'] is not None]
        return f"20d {st.mean(f20):+.2f}% ({sum(x > 0 for x in f20) / len(f20) * 100:.0f}% up) · 60d {st.mean(f60):+.2f}% · ירידה מקס' 60d {st.mean(dd):.1f}%"
    out.append(f"| {label} | {desc(pts[:k])} | {desc(pts[k:-k])} | {desc(pts[-k:])} | {pts[k][key]:.2f} / {pts[-k][key]:.2f} |")

out = ["# מחקר שלב 2: מדדי לחץ מאופציות בשוק דובי (פרוקסי היסטוריים 2008–2026)\n",
       f"{len(rows)} ימי מסחר · שוק דובי לפי התקופות: " + ", ".join(f"{a.strftime('%m/%y')}–{b.strftime('%m/%y')}" for a, b in BEAR) + "\n",
       "כל שורה: שלישון נמוך / אמצע / גבוה של המדד באותו יום, ומה S&P עשה אחר כך. 'ירידה מקס'' = הנקודה הנמוכה ביותר ב-60 הימים הבאים.\n"]
for title, sub in (("כל התקופה", rows), ("בתוך שוק דובי", [m for m in rows if m['bear']]), ("בשוק שורי", [m for m in rows if not m['bear']])):
    out.append(f"\n## {title} ({len(sub)} ימים)\n")
    out.append("| מדד | שלישון נמוך | אמצע | שלישון גבוה | חיתוכים |\n|---|---|---|---|---|")
    for key, label in (('vix_rv', 'VIX / תנודתיות בפועל'), ('term', 'VIX / VIX6M'), ('skew_z', 'SKEW (z 60d)')):
        tercile_table(sub, key, out, label)

# 2022 month by month
out.append("\n## 2022 חודש-חודש (ממוצע חודשי של המדדים, ותשואת 20 יום מסוף החודש)\n")
out.append("| חודש | VIX/RV | VIX/VIX6M | SKEW z | S&P 20 ימים אחרי |\n|---|---|---|---|---|")
for mo in range(1, 13):
    sub = [m for m in rows if m['d'].year == 2022 and m['d'].month == mo]
    if not sub: continue
    last = sub[-1]
    f = lambda k: st.mean(x[k] for x in sub if x[k] is not None)
    out.append(f"| {mo:02d}/2022 | {f('vix_rv'):.2f} | {f('term'):.2f} | {f('skew_z'):+.2f} | {'' if last['f20'] is None else f'{last['f20']:+.1f}%'} |")

# complacency signal: low vix_rv AND term low → next 60d max drawdown, by regime
out.append("\n## 'שאננות' (VIX/RV בשלישון הנמוך וגם עקום תלול) — מה קרה אחר כך\n")
pts = [m for m in rows if m['vix_rv'] is not None and m['term'] is not None and m['dd60'] is not None]
vr = sorted(m['vix_rv'] for m in pts); tm = sorted(m['term'] for m in pts)
cv, ct = vr[len(vr) // 3], tm[len(tm) // 3]
comp = [m for m in pts if m['vix_rv'] <= cv and m['term'] <= ct]
rest = [m for m in pts if not (m['vix_rv'] <= cv and m['term'] <= ct)]
for lbl, g in (("שאננות", comp), ("שאר הימים", rest)):
    out.append(f"- {lbl}: n={len(g)} · 20d {st.mean(m['f20'] for m in g if m['f20'] is not None):+.2f}% · 60d {st.mean(m['f60'] for m in g if m['f60'] is not None):+.2f}% · ירידה מקס' 60d {st.mean(m['dd60'] for m in g):.1f}% · ירידה של 10%+ ב-60 יום: {sum(m['dd60'] <= -10 for m in g) / len(g) * 100:.1f}%")
# stress signal: term >= 1 (inversion)
inv = [m for m in pts if m['term'] >= 1.0]; noninv = [m for m in pts if m['term'] < 1.0]
out.append(f"\n## היפוך עקום (VIX ≥ VIX6M = סטרס)\n- היפוך: n={len(inv)} · 20d {st.mean(m['f20'] for m in inv if m['f20'] is not None):+.2f}% ({sum(m['f20'] > 0 for m in inv if m['f20'] is not None) / len(inv) * 100:.0f}% up) · 60d {st.mean(m['f60'] for m in inv if m['f60'] is not None):+.2f}%\n- ללא היפוך: n={len(noninv)} · 20d {st.mean(m['f20'] for m in noninv if m['f20'] is not None):+.2f}% · 60d {st.mean(m['f60'] for m in noninv if m['f60'] is not None):+.2f}%")
text = "\n".join(out); print(text)
os.makedirs('docs/research', exist_ok=True)
open('docs/research/options-vol-regimes-phase2.md', 'w', encoding='utf-8').write(text + "\n")
print("\n[saved] docs/research/options-vol-regimes-phase2.md")
