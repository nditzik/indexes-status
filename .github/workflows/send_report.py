"""
Daily Market Briefing Email
===========================
Structured 6-section brief, readable in under 60 seconds.
Replicates the dashboard's scoring logic (MCC, Technical, Options Flow)
and renders as a compact HTML email sent via Brevo on every CSV push.
"""

import csv, json, os, urllib.request, urllib.error, glob, io

# ═══════════════════════════════════════════════════
#  Helpers
# ═══════════════════════════════════════════════════
def num(v):
    """Parse number from CSV field, handles %, +, , and N/A gracefully."""
    if v is None: return None
    s = str(v).strip().replace('%','').replace('+','').replace(',','')
    try: return float(s)
    except: return None

def fmt_money(v):
    if v is None: return '—'
    a = abs(v)
    sign = '' if v >= 0 else '−'
    if a >= 1e9: return f'{sign}${a/1e9:.2f}B'
    if a >= 1e6: return f'{sign}${a/1e6:.1f}M'
    if a >= 1e3: return f'{sign}${a/1e3:.0f}K'
    return f'{sign}${a:.0f}'

def pct(v, d=1):
    if v is None: return '—'
    sign = '+' if v > 0 else ''
    return f'{sign}{v:.{d}f}%'

def clamp(v, lo=0, hi=100):
    return max(lo, min(hi, v))

def load_csv(path):
    with open(path, encoding='utf-8-sig', newline='') as f:
        txt = f.read().replace('\r\n','\n').replace('\r','\n')
    return list(csv.DictReader(io.StringIO(txt)))

# ═══════════════════════════════════════════════════
#  Parse today's watchlist (data.txt = copy of latest CSV)
# ═══════════════════════════════════════════════════
all_rows = load_csv('data/data.txt')

def find_macro(sym):
    for r in all_rows:
        if r.get('Symbol','').strip() == sym: return r
    return None

spx_row = find_macro('$SPX')
vix_row = find_macro('$VIX')
dxy_row = find_macro('$DXY')
tnx_row = find_macro('$TNX')

spx = None
if spx_row:
    spx = {
        'price':  num(spx_row.get('Latest')),
        'chgPct': num(spx_row.get('%Change')),
        'ma20':   num(spx_row.get('20D MA')),
        'ma50':   num(spx_row.get('50D MA')),
        'ma150':  num(spx_row.get('150D MA')),
        'ma200': num(spx_row.get('200D MA')),
        'high52': num(spx_row.get('52W %/High')),
    }
vix = num(vix_row.get('Latest')) if vix_row else None
dxy = num(dxy_row.get('Latest')) if dxy_row else None
tnx = num(tnx_row.get('Latest')) if tnx_row else None

# Non-macro stocks
stocks = []
for row in all_rows:
    sym = row.get('Symbol','').strip()
    if not sym or sym.startswith('$'): continue
    latest = num(row.get('Latest'))
    if latest is None or latest <= 0: continue
    s = {
        'sym': sym, 'name': (row.get('Name','') or '').strip('"'),
        'latest': latest,
        'ma20':  num(row.get('20D MA')),
        'ma50':  num(row.get('50D MA')),
        'ma150': num(row.get('150D MA')),
        'ma200': num(row.get('200D MA')),
        'chg':   num(row.get('%Change')),
        'rsi':   (row.get('RSI Rank','') or '').strip(),
        'rvol':  num(row.get('20D RelVol')) or 0,
        'w52':   num(row.get('52W %/High')) or 0,
    }
    s['dist200']  = (latest/s['ma200'] - 1) * 100 if s['ma200'] and s['ma200'] > 0 else None
    s['ma_score'] = sum(1 for k in ('ma20','ma50','ma150','ma200') if s[k] and latest > s[k])
    stocks.append(s)

total = len(stocks)
print(f'Stocks parsed: {total}')

# ═══════════════════════════════════════════════════
#  Breadth metrics
# ═══════════════════════════════════════════════════
above = lambda k: sum(1 for s in stocks if s[k] and s['latest'] > s[k])
a20, a50, a150, a200 = above('ma20'), above('ma50'), above('ma150'), above('ma200')
golden = sum(1 for s in stocks if s['ma50'] and s['ma200'] and s['ma50'] > s['ma200'])
nh = sum(1 for s in stocks if s['w52'] >= -5)
nl = sum(1 for s in stocks if s['w52'] <= -30)
nh_nl = 99.0 if (nl == 0 and nh > 0) else (nh / nl if nl > 0 else 0)
advancing  = sum(1 for s in stocks if s['chg'] is not None and s['chg'] > 0)
declining  = sum(1 for s in stocks if s['chg'] is not None and s['chg'] < 0)
rsi_above50 = sum(1 for s in stocks if s['rsi'] in ('Above 50','New Above 50','Above 70','New Above 70'))
oversold    = sum(1 for s in stocks if s['rsi'] in ('Below 30','New Below 30'))

p200   = a200 / total * 100 if total else 0
health = round((a200/total*100)*0.30 + (golden/total*100)*0.25 + (rsi_above50/total*100)*0.25 + (a20/total*100)*0.20) if total else 0

chg_vals   = [s['chg'] for s in stocks if s['chg'] is not None]
avg_change = sum(chg_vals) / len(chg_vals) if chg_vals else 0

# ═══════════════════════════════════════════════════
#  Historical avg-change (last 25 sessions) → Dist Days + Weekly
# ═══════════════════════════════════════════════════
hist_files = sorted(glob.glob('data/watchlist-sp-500-intraday-*.csv'))
history = []
for hf in hist_files[-26:]:
    try:
        rows = load_csv(hf)
        vals = []
        for r in rows:
            sym = r.get('Symbol','').strip()
            if not sym or sym.startswith('$'): continue
            c = num(r.get('%Change'))
            if c is not None and c != 0:
                vals.append(c)
        if vals:
            history.append(sum(vals)/len(vals))
    except Exception as e:
        print(f'History load skip {hf}: {e}')

last25 = history[-25:]
last5  = history[-5:]
dist_days     = sum(1 for v in last25 if v < -0.2)
weekly_change = sum(last5) if len(last5) >= 3 else None

# ═══════════════════════════════════════════════════
#  Score 1 · Market (MCC)
# ═══════════════════════════════════════════════════
def market_score():
    parts, max_ = [], 0
    # MA200 (25)
    parts.append(25 if p200 >= 65 else 18 if p200 >= 50 else 10 if p200 >= 40 else 3)
    max_ += 25
    # VIX (20)
    if vix is not None:
        parts.append(20 if vix < 15 else 15 if vix < 20 else 8 if vix < 25 else 2)
        max_ += 20
    # Distribution Days (15, needs ≥5 hist points)
    if len(last25) >= 5:
        parts.append(15 if dist_days <= 2 else 8 if dist_days <= 4 else 2)
        max_ += 15
    # Breadth/Health (15)
    parts.append(15 if health >= 70 else 10 if health >= 55 else 5 if health >= 40 else 1)
    max_ += 15
    # NH/NL (10)
    if nh_nl == 99 or nh_nl >= 1.5: parts.append(10)
    elif nh_nl >= 1.0: parts.append(7)
    elif nh_nl >= 0.7: parts.append(3)
    else: parts.append(0)
    max_ += 10
    # Weekly change (5)
    if weekly_change is not None:
        parts.append(5 if weekly_change > 0.5 else 3 if weekly_change >= -0.5 else 0)
        max_ += 5
    if max_ == 0: return None
    return clamp(round(sum(parts) / max_ * 100))

m_score = market_score()

# ═══════════════════════════════════════════════════
#  Score 2 · Technical (SPX technicals)
# ═══════════════════════════════════════════════════
def tech_score():
    if not spx or spx['price'] is None: return None
    parts, max_ = [], 0
    p = spx['price']
    if spx['ma20']:  parts.append(15 if p > spx['ma20']  else 5);  max_ += 15
    if spx['ma50']:  parts.append(20 if p > spx['ma50']  else 5);  max_ += 20
    if spx['ma200']: parts.append(25 if p > spx['ma200'] else 3);  max_ += 25
    if spx['ma20'] and spx['ma50'] and spx['ma200']:
        if   spx['ma20'] > spx['ma50'] > spx['ma200']: parts.append(15)
        elif spx['ma20'] < spx['ma50'] < spx['ma200']: parts.append(0)
        elif spx['ma20'] > spx['ma50']:                parts.append(10)
        else:                                          parts.append(5)
        max_ += 15
    if spx['high52'] is not None:
        d = abs(spx['high52'])
        parts.append(10 if d <= 5 else 7 if d <= 10 else 4 if d <= 20 else 1)
        max_ += 10
    if spx['chgPct'] is not None:
        c = spx['chgPct']
        parts.append(5 if c > 0.5 else 3 if c >= -0.5 else 0)
        max_ += 5
    if max_ == 0: return None
    return clamp(round(sum(parts) / max_ * 100))

t_score = tech_score()

# ═══════════════════════════════════════════════════
#  Score 3 · Options Flow
# ═══════════════════════════════════════════════════
flow_files = sorted(glob.glob('data/spx-options-flow-*.csv'))
flow = None
if flow_files:
    try:
        rows = load_csv(flow_files[-1])
        call_tr = put_tr = 0
        call_p = put_p = 0.0
        for r in rows:
            t = (r.get('Type','') or '').strip().lower()
            pr = num(r.get('Premium')) or 0
            if t == 'call':
                call_tr += 1; call_p += pr
            elif t == 'put':
                put_tr += 1; put_p += pr
        total_tr = call_tr + put_tr
        total_p  = call_p + put_p
        if total_tr > 0:
            pc_tr  = put_tr / call_tr if call_tr > 0 else None
            pc_p   = put_p  / call_p  if call_p  > 0 else None
            net_p  = call_p - put_p
            ts = 0 if pc_tr is None else 35 if pc_tr < 0.70 else 27 if pc_tr < 1.00 else 15 if pc_tr < 1.30 else 5
            ps = 0 if pc_p  is None else 50 if pc_p  < 0.70 else 38 if pc_p  < 1.00 else 22 if pc_p  < 1.30 else 5
            net_pct = net_p / total_p if total_p > 0 else 0
            ns = 15 if net_pct > 0.10 else 8 if net_pct > -0.10 else 2
            flow = {
                'score': clamp(round(ts + ps + ns)),
                'pc_tr': pc_tr, 'pc_p': pc_p, 'net_p': net_p,
                'call_p_pct': call_p/total_p*100 if total_p else 0,
                'put_p_pct':  put_p/total_p*100  if total_p else 0,
                'call_tr_pct': call_tr/total_tr*100,
                'put_tr_pct':  put_tr/total_tr*100,
                'call_tr': call_tr, 'put_tr': put_tr,
            }
    except Exception as e:
        print(f'Options flow parse error: {e}')

f_score = flow['score'] if flow else None

# ═══════════════════════════════════════════════════
#  Combined signal (40% M + 35% T + 25% F, auto re-normalize)
# ═══════════════════════════════════════════════════
def combined():
    w = {'m': 0.40, 't': 0.35, 'f': 0.25}
    num_, den = 0.0, 0.0
    if m_score is not None: num_ += w['m']*m_score; den += w['m']
    if t_score is not None: num_ += w['t']*t_score; den += w['t']
    if f_score is not None: num_ += w['f']*f_score; den += w['f']
    if den == 0: return None
    return clamp(round(num_/den))

c_score = combined()

# ═══════════════════════════════════════════════════
#  Classification — state / risk / bias
# ═══════════════════════════════════════════════════
def classify_combined(s):
    if s is None:      return ('—','—','—','neutral')
    if s >= 80:        return ('שורי מאומת חזק',   'נמוך',   'לונגים רחבים',              'bullish')
    if s >= 65:        return ('אישור חיובי',      'בינוני', 'לונגים סלקטיביים',          'constructive')
    if s >= 45:        return ('מעורב ללא יתרון',  'בינוני', 'סלקטיבי / מאוזן',            'neutral')
    if s >= 30:        return ('זהירות / סטייה',   'גבוה',   'הפחת חשיפה',                 'caution')
    return              ('דפנסיבי / סיכון גבוה', 'גבוה',   'מזומן / הגנתי',             'riskoff')

state_label, risk_level, bias_text, state_key = classify_combined(c_score)
STATE_COLORS = {
    'bullish':      '#10b981',
    'constructive': '#14b8a6',
    'neutral':      '#64748b',
    'caution':      '#f59e0b',
    'riskoff':      '#ef4444',
}
accent = STATE_COLORS.get(state_key, '#64748b')

# ═══════════════════════════════════════════════════
#  Section 1 narrative — 1-2 sentences, trader tone
# ═══════════════════════════════════════════════════
def narrative():
    # Pick a lead sentence based on state, then add one qualifying sentence
    lead = ''
    if state_key == 'bullish':
        lead = 'שוק חזק ורחב'
    elif state_key == 'constructive':
        lead = 'שוק חיובי'
    elif state_key == 'neutral':
        lead = 'שוק ללא כיוון ברור'
    elif state_key == 'caution':
        lead = 'שוק נחלש'
    else:  # riskoff
        lead = 'לחץ מכירות רחב בשוק'

    # Qualifier — what it means / what to watch
    tail = ''
    if state_key in ('bullish','constructive'):
        if len(last25) >= 5 and dist_days >= 3:
            tail = 'אבל יש לחץ מכירות — סלקטיביות'
        elif f_score is not None and f_score < 45:
            tail = 'אבל Flow לא מאשר — זהירות'
        elif flow and flow['pc_p'] is not None and flow['pc_p'] > 1.2:
            tail = 'אבל הגנות מוגברות — לא לרדוף'
        elif vix is not None and vix > 22:
            tail = 'אבל תנודתיות עולה — לא להתפזר'
        elif f_score is not None and f_score >= 65:
            tail = 'Flow מאשר — מגמה תומכת'
        else:
            tail = 'מגמה תומכת'
    elif state_key == 'neutral':
        if f_score is not None and f_score >= 65:
            tail = 'Flow שורי — סימן חיובי'
        elif f_score is not None and f_score < 40:
            tail = 'Flow דפנסיבי — עדיף להמתין'
        elif vix is not None and vix > 22:
            tail = 'תנודתיות גבוהה — מחכה לכיוון'
        else:
            tail = 'מחכה לאות ברור'
    elif state_key == 'caution':
        if vix is not None and vix > 22:
            tail = 'תנודתיות עולה — להקטין סיכון'
        elif p200 < 45:
            tail = 'רוב המניות מתחת ל-200MA — לא לקנות'
        else:
            tail = 'להיזהר מהתרחבות חשיפה'
    else:  # riskoff
        if vix is not None and vix > 28:
            tail = 'פאניקה — לחכות שהאבק ישקע'
        else:
            tail = 'עדיף להיות בצד'

    return f'{lead}. {tail}.'

# ═══════════════════════════════════════════════════
#  Section 2 — Key signals (short, trader-voice)
# ═══════════════════════════════════════════════════
def key_signals():
    items = []
    # SPX vs MAs — one clean bullet based on how many MAs price is above
    if spx and spx['price']:
        ok = sum(1 for v in (spx['ma20'], spx['ma50'], spx['ma200']) if v and spx['price'] > v)
        if ok == 3:
            items.append('SPX מעל כל הממוצעים — מגמה חיובית')
        elif ok == 2:
            items.append('SPX מעל 2 ממוצעים — מגמה חלקית')
        elif ok == 1:
            items.append('SPX מעל ממוצע אחד — מגמה חלשה')
        else:
            items.append('SPX מתחת לכל הממוצעים — מגמה שלילית')
    # Alignment — only mention if clear
    if spx and spx['ma20'] and spx['ma50'] and spx['ma200']:
        if spx['ma20'] > spx['ma50'] > spx['ma200']:
            items.append('סידור ממוצעים שורי — 20 מעל 50 מעל 200')
        elif spx['ma20'] < spx['ma50'] < spx['ma200']:
            items.append('סידור ממוצעים דובי — 20 מתחת 50 מתחת 200')
    # Distribution days
    if len(last25) >= 5 and dist_days >= 3:
        items.append(f'{dist_days} ימי מכירות כבדים — לחץ מוסדי')
    # Flow premium (primary signal)
    if flow and flow['pc_p'] is not None:
        if flow['pc_p'] < 0.70:
            items.append('פרמיות Call מובילות בגדול — כסף שורי חזק')
        elif flow['pc_p'] < 1.00:
            items.append('פרמיות Call מובילות — כסף שורי')
        elif flow['pc_p'] < 1.30:
            items.append('פרמיות מאוזנות — ללא כיוון ברור')
        else:
            items.append('פרמיות Put גבוהות — ביקוש הגנות')
    # Flow trades (crowd)
    if flow and flow['pc_tr'] is not None:
        if flow['pc_tr'] < 0.70:
            items.append('גם הקהל שורי — טריידים ל-Call')
        elif flow['pc_tr'] >= 1.30:
            items.append('טריידים נוטים ל-Put — קהל זהיר')
    # Divergences (high priority, override if present)
    if t_score is not None and f_score is not None:
        if t_score >= 65 and f_score < 45:
            items.append('⚠ מחיר חזק, זרימה חלשה — סטייה')
        elif t_score < 45 and f_score >= 65:
            items.append('⚠ זרימה שורית מול מחיר חלש — סטייה')
    return items[:5]

def signals_conclusion():
    # One punchy line — trader interpretation
    if flow is None: return ''
    if m_score is None or f_score is None: return ''
    if f_score >= 65 and m_score < 50:
        return 'כסף גדול שורי, breadth מפגר'
    if f_score < 40 and m_score >= 60:
        return 'השוק נראה יפה — אבל הזרימה לא נקייה'
    if f_score >= 70 and m_score >= 65:
        return 'הכל מיושר — תמונה חיובית'
    if t_score is not None and f_score is not None and abs(t_score - f_score) >= 25:
        return 'המחיר והזרימה לא מסתדרים — זהירות'
    if f_score < 35:
        return 'הזרימה דובית — להיזהר'
    if flow['pc_p'] is not None and flow['pc_p'] > 1.30:
        return 'קהל קונה הגנות — סימן לערנות'
    return 'הזרימה מאוזנת — ללא הכרעה'

signals_items = key_signals()
conclusion   = signals_conclusion()

# ═══════════════════════════════════════════════════
#  Section 4 — stocks (5 strong / 5 weak)
# ═══════════════════════════════════════════════════
def momentum(s):
    sc = 0
    if s['dist200'] is not None and s['dist200'] > 0: sc += 30
    if s['rsi'] in ('Above 70','New Above 70','Above 50','New Above 50'): sc += 25
    if s['w52'] >= -10: sc += 20
    if s['rvol'] > 1.2: sc += 15
    if s['chg'] is not None and s['chg'] > 0: sc += 10
    return sc

def weakness(s):
    sc = 0
    if s['dist200'] is not None and s['dist200'] < 0: sc += 30
    if s['rsi'] in ('Below 30','New Below 30','Below 50','New Below 50'): sc += 25
    if s['w52'] <= -25: sc += 20
    if s['chg'] is not None and s['chg'] < -1: sc += 15
    if s['rvol'] > 1.2: sc += 10
    return sc

# Short human-readable meaning per stock (trader voice)
def strong_meaning(s):
    chg = s['chg'] or 0
    if s['rvol'] > 2 and chg > 2:
        return 'פריצה חזקה היום'
    if chg > 4:
        return 'עלייה חדה היום'
    if s['w52'] >= -3:
        return 'קרובה לשיא — חזקה'
    if s['rsi'] in ('Above 70','New Above 70','New Above 80'):
        return 'במומנטום שורי'
    if s['rsi'] == 'Above 80':
        return 'מומנטום חזק מאוד'
    if s['dist200'] is not None and s['dist200'] > 30:
        return 'הרחק מעל 200MA'
    return 'ממשיכה להוביל'

def weak_meaning(s):
    chg = s['chg'] or 0
    if chg < -5:
        return 'נפילה חדה היום'
    if s['w52'] <= -45:
        return 'רחוקה מהשיא — חולשה עמוקה'
    if s['rsi'] in ('Below 30','New Below 30','Below 20'):
        return 'במכירת יתר'
    if s['ma_score'] == 0:
        return 'מתחת לכל הממוצעים'
    if chg < -2:
        return 'יורדת היום'
    if s['w52'] <= -30:
        return 'חולשה ברורה'
    return 'נחלשת'

strong = sorted(stocks, key=momentum, reverse=True)[:5]
weak   = sorted(stocks, key=weakness, reverse=True)[:5]

# ═══════════════════════════════════════════════════
#  Section 5 — alerts (only if relevant)
# ═══════════════════════════════════════════════════
def alerts():
    al = []
    if vix is not None and vix > 25:
        al.append('VIX מעל 25 — תנודתיות חריגה')
    if flow and flow['pc_p'] is not None and flow['pc_p'] > 1.30:
        al.append('ביקוש הגנות גבוה — קהל חושש')
    if len(last25) >= 5 and dist_days >= 5:
        al.append(f'{dist_days} ימי מכירות כבדים — לחץ מוסדי מצטבר')
    if t_score is not None and f_score is not None and abs(t_score - f_score) >= 30:
        al.append('סטייה חריפה בין מחיר לזרימה')
    if nl >= 30 and nh_nl < 0.5 and nh_nl != 99:
        al.append(f'{nl} מניות רחוקות מהשיא — חולשה רחבה')
    return al[:3]

alerts_list = alerts()

# ═══════════════════════════════════════════════════
#  Section 6 — Action line
# ═══════════════════════════════════════════════════
def action_line():
    if c_score is None: return '—'
    if c_score >= 80: return 'מגמה תומכת — אפשר להגדיל חשיפה בהדרגה'
    if c_score >= 65: return 'לונגים סלקטיביים — להיזהר מהתרחבות'
    if c_score >= 45: return 'סלקטיביות — להעדיף חזקות ברורות'
    if c_score >= 30: return 'גישה דפנסיבית — להקטין סיכון'
    return 'הגנתי — עדיף להיות בצד'

# ═══════════════════════════════════════════════════
#  Date label
# ═══════════════════════════════════════════════════
date_label = ''
if hist_files:
    date_label = os.path.basename(hist_files[-1]).replace('watchlist-sp-500-intraday-','').replace('.csv','')

# ═══════════════════════════════════════════════════
#  HTML build
# ═══════════════════════════════════════════════════
def score_block(lbl, v):
    if v is None:
        color = '#cbd5e0'; txt = '—'
    else:
        color = '#10b981' if v >= 65 else '#f59e0b' if v >= 45 else '#ef4444'
        txt = str(v)
    return (f'<td align="center" style="padding:12px 8px;text-align:center;width:33%;">'
            f'<div style="font-size:10px;color:#718096;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;text-align:center;">{lbl}</div>'
            f'<div style="font-size:26px;font-weight:700;color:{color};line-height:1;text-align:center;">{txt}</div>'
            f'</td>')

def stock_row(s, pos=True):
    meaning = strong_meaning(s) if pos else weak_meaning(s)
    meaning_color = '#2f855a' if pos else '#c53030'
    return (f'<tr>'
            f'<td align="right" dir="ltr" style="padding:8px 10px;font-weight:700;color:#2b6cb0;width:70px;text-align:right;font-size:13px;">{s["sym"]}</td>'
            f'<td align="right" style="padding:8px 10px;color:{meaning_color};font-size:13px;font-weight:500;text-align:right;">— {meaning}</td>'
            f'</tr>')

# Build each section
CARD = 'background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,0.04);margin-bottom:12px;direction:rtl;'

s1_html = f"""
<div dir="rtl" style="{CARD}padding:20px 22px;border-top:3px solid {accent};text-align:right;">
  <div style="font-size:11px;color:#718096;letter-spacing:0.1em;text-transform:uppercase;font-weight:600;margin-bottom:6px;text-align:right;">סיכום השוק</div>
  <div style="font-size:22px;font-weight:700;color:{accent};line-height:1.1;margin-bottom:10px;text-align:right;">{state_label}</div>
  <table dir="rtl" align="right" style="width:100%;font-size:12px;color:#2d3748;border-collapse:collapse;margin-bottom:10px;direction:rtl;">
    <tr>
      <td align="right" style="padding:2px 0;color:#718096;width:80px;text-align:right;">רמת סיכון</td>
      <td align="right" style="padding:2px 0;font-weight:600;text-align:right;">{risk_level}</td>
    </tr>
    <tr>
      <td align="right" style="padding:2px 0;color:#718096;text-align:right;">הטיית פוזיציה</td>
      <td align="right" style="padding:2px 0;font-weight:600;text-align:right;">{bias_text}</td>
    </tr>
  </table>
  <div dir="rtl" style="font-size:13px;color:#4a5568;line-height:1.55;border-top:1px solid #edf2f7;padding-top:10px;text-align:right;">{narrative()}</div>
</div>
"""

s2_items_html = ''.join(f'<li style="padding:7px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#2d3748;text-align:right;direction:rtl;">{it}</li>' for it in signals_items)
s2_conclusion_html = (f'<div dir="rtl" style="margin-top:12px;padding:10px 14px;background:#f7fafc;border-right:3px solid {accent};font-size:13px;color:#2d3748;font-weight:600;text-align:right;">{conclusion}</div>'
                     if conclusion else '')
s2_html = f"""
<div dir="rtl" style="{CARD}padding:20px 22px;text-align:right;">
  <div style="font-size:11px;color:#718096;letter-spacing:0.1em;text-transform:uppercase;font-weight:600;margin-bottom:10px;text-align:right;">איתותים מרכזיים</div>
  <ul dir="rtl" style="margin:0;padding:0;list-style:none;text-align:right;">{s2_items_html}</ul>
  {s2_conclusion_html}
</div>
"""

spx_price_str = f'{spx["price"]:,.2f}' if (spx and spx["price"]) else '—'
spx_chg_color = '#10b981' if (spx and spx["chgPct"] and spx["chgPct"] > 0) else ('#ef4444' if (spx and spx["chgPct"] and spx["chgPct"] < 0) else '#718096')
spx_chg_str   = pct(spx["chgPct"], 2) if (spx and spx["chgPct"] is not None) else '—'
nh_nl_str     = '∞' if nh_nl == 99 else f'{nh_nl:.2f}'
vix_str       = f'{vix:.2f}' if vix is not None else '—'

s3_html = f"""
<div dir="rtl" style="{CARD}padding:20px 22px;text-align:right;">
  <div style="font-size:11px;color:#718096;letter-spacing:0.1em;text-transform:uppercase;font-weight:600;margin-bottom:12px;text-align:right;">נתוני שוק</div>
  <table dir="rtl" style="width:100%;border-collapse:collapse;border:1px solid #edf2f7;border-radius:8px;overflow:hidden;background:#f7fafc;direction:rtl;">
    <tr>
      {score_block('Market', m_score)}
      {score_block('Technical', t_score)}
      {score_block('Options Flow', f_score)}
    </tr>
  </table>
  <table dir="rtl" style="width:100%;font-size:13px;color:#2d3748;margin-top:14px;border-collapse:collapse;direction:rtl;">
    <tr style="background:#f7fafc;">
      <td align="right" style="padding:8px 12px;color:#718096;width:80px;text-align:right;">SPX</td>
      <td align="right" style="padding:8px 12px;font-weight:600;font-variant-numeric:tabular-nums;text-align:right;"><span dir="ltr" style="unicode-bidi:isolate;">{spx_price_str}</span> <span dir="ltr" style="color:{spx_chg_color};font-weight:600;unicode-bidi:isolate;">{spx_chg_str}</span></td>
      <td align="right" style="padding:8px 12px;color:#718096;width:60px;text-align:right;">VIX</td>
      <td align="right" style="padding:8px 12px;font-weight:600;text-align:right;"><span dir="ltr" style="unicode-bidi:isolate;">{vix_str}</span></td>
    </tr>
    <tr>
      <td align="right" style="padding:8px 12px;color:#718096;text-align:right;">% מעל MA200</td>
      <td align="right" style="padding:8px 12px;font-weight:600;text-align:right;"><span dir="ltr" style="unicode-bidi:isolate;">{int(p200)}% ({a200}/{total})</span></td>
      <td align="right" style="padding:8px 12px;color:#718096;text-align:right;">NH/NL</td>
      <td align="right" style="padding:8px 12px;font-weight:600;text-align:right;"><span dir="ltr" style="unicode-bidi:isolate;">{nh}/{nl} = {nh_nl_str}</span></td>
    </tr>
  </table>
</div>
"""

strong_rows = ''.join(stock_row(s, True) for s in strong)
weak_rows   = ''.join(stock_row(s, False) for s in weak)
s4_html = f"""
<div dir="rtl" style="{CARD}padding:20px 22px;text-align:right;">
  <div style="font-size:11px;color:#718096;letter-spacing:0.1em;text-transform:uppercase;font-weight:600;margin-bottom:12px;text-align:right;">מניות — חוזק / חולשה</div>
  <table dir="rtl" style="width:100%;border-collapse:collapse;direction:rtl;">
    <tr style="background:#f0fdf4;"><td align="right" colspan="2" style="padding:8px 10px;font-size:12px;color:#2f855a;font-weight:700;text-align:right;">▲ חזקות</td></tr>
    {strong_rows}
    <tr style="background:#fef2f2;"><td align="right" colspan="2" style="padding:8px 10px;font-size:12px;color:#c53030;font-weight:700;text-align:right;">▼ חלשות</td></tr>
    {weak_rows}
  </table>
</div>
"""

s5_html = ''
if alerts_list:
    al_items = ''.join(f'<li style="padding:5px 0;font-size:13px;color:#744210;text-align:right;direction:rtl;">• {a}</li>' for a in alerts_list)
    s5_html = f"""
<div dir="rtl" style="background:#fffaf0;border-radius:10px;border-right:4px solid #f59e0b;padding:16px 22px;margin-bottom:12px;direction:rtl;text-align:right;">
  <div style="font-size:11px;color:#c05621;letter-spacing:0.1em;text-transform:uppercase;font-weight:700;margin-bottom:6px;text-align:right;">⚡ התראות</div>
  <ul dir="rtl" style="margin:0;padding:0;list-style:none;text-align:right;">{al_items}</ul>
</div>
"""

s6_html = f"""
<div dir="rtl" style="background:{accent};color:#fff;border-radius:10px;padding:18px 22px;margin-bottom:12px;direction:rtl;text-align:right;">
  <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;opacity:0.85;margin-bottom:4px;font-weight:600;text-align:right;">גישה להיום</div>
  <div style="font-size:15px;font-weight:600;line-height:1.4;text-align:right;">{action_line()}</div>
</div>
"""

html = f"""<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="utf-8"></head>
<body dir="rtl" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f4f6f9;padding:16px;color:#1a202c;margin:0;direction:rtl;text-align:right;">
<div dir="rtl" style="max-width:620px;margin:auto;direction:rtl;text-align:right;">

  <!-- Header -->
  <div dir="rtl" style="background:#0f0f11;padding:16px 22px;color:#fff;border-radius:10px;margin-bottom:12px;direction:rtl;">
    <table dir="rtl" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;direction:rtl;">
      <tr>
        <td align="right" style="vertical-align:middle;width:64px;text-align:right;">
          <img src="https://nditzik.github.io/indexes-status/logo.png" alt="Logo" width="56" height="auto" style="display:block;height:auto;width:56px;max-width:56px;border:0;">
        </td>
        <td align="right" style="vertical-align:middle;padding-right:0;padding-left:14px;text-align:right;">
          <div style="font-size:10px;opacity:0.65;letter-spacing:0.15em;text-transform:uppercase;margin-bottom:3px;text-align:right;">Daily Briefing</div>
          <div style="font-size:16px;font-weight:600;text-align:right;">S&amp;P 500 · {date_label}</div>
        </td>
        <td align="left" style="vertical-align:middle;text-align:left;">
          <a href="https://nditzik.github.io/indexes-status/" style="color:#fff;background:#3b82f6;padding:6px 12px;border-radius:6px;font-size:11px;text-decoration:none;font-weight:500;white-space:nowrap;">דשבורד ←</a>
        </td>
      </tr>
    </table>
  </div>

  {s1_html}
  {s2_html}
  {s3_html}
  {s4_html}
  {s5_html}
  {s6_html}

  <div style="text-align:center;font-size:10px;color:#a0aec0;padding:8px;line-height:1.4;">
    לא מהווה ייעוץ השקעות · מידע אישי למנויים · S&amp;P 500 Dashboard
  </div>
</div>
</body></html>"""

# ═══════════════════════════════════════════════════
#  Send via Brevo
# ═══════════════════════════════════════════════════
api_key = os.environ.get("BREVO_API_KEY", "")

# TEST_RECIPIENTS env var overrides default list (comma-separated emails)
_test = os.environ.get("TEST_RECIPIENTS", "").strip()
if _test:
    recipients = [{"email": e.strip()} for e in _test.split(",") if e.strip()]
    subject_prefix = "🧪 [TEST] "
    print(f"TEST MODE — sending only to: {[r['email'] for r in recipients]}")
else:
    recipients = [
        {"email": "nditzik@gmail.com"},
        {"email": "eddie@teco.org.il"},
        {"email": "yakiryona3@gmail.com"},
        {"email": "ofeknidam@gmail.com"}
    ]
    subject_prefix = "📊 "

payload = json.dumps({
    "sender": {"name": "S&P Dashboard", "email": "nditzik@gmail.com"},
    "to": recipients,
    "subject": f"{subject_prefix}{state_label} · S&P 500 {date_label}",
    "htmlContent": html
}).encode()

req = urllib.request.Request(
    'https://api.brevo.com/v3/smtp/email',
    data=payload,
    headers={
        'api-key': api_key,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
)
try:
    with urllib.request.urlopen(req) as resp:
        print('Email sent:', resp.read().decode())
except urllib.error.HTTPError as e:
    print(f'HTTP Error {e.code}: {e.reason}')
    print('Response body:', e.read().decode())
    raise
