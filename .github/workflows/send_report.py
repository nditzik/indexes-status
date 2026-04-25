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
#  Sector breakdown — who's pushing the market down / up today
# ═══════════════════════════════════════════════════
try:
    with open('data/sectors.json', encoding='utf-8') as sf:
        _sectors = json.load(sf)
    SECTOR_MAP = _sectors.get('tickers', {})
    SECTOR_HE  = _sectors.get('codes', {})
except Exception as _e:
    print(f'Sectors load skip: {_e}')
    SECTOR_MAP, SECTOR_HE = {}, {}

def sector_breakdown():
    by_sec = {}
    for s in stocks:
        sec = SECTOR_MAP.get(s['sym'])
        if not sec: continue
        if sec not in by_sec:
            by_sec[sec] = {'chgs': [], 'above200': 0, 'total': 0}
        by_sec[sec]['total'] += 1
        if s['chg'] is not None:
            by_sec[sec]['chgs'].append(s['chg'])
        if s['dist200'] is not None and s['dist200'] > 0:
            by_sec[sec]['above200'] += 1
    out = []
    for sec, d in by_sec.items():
        if not d['chgs']: continue
        avg = sum(d['chgs']) / len(d['chgs'])
        out.append({
            'sec': sec,
            'name': SECTOR_HE.get(sec, sec),
            'avg_chg': avg,
            'pct200': d['above200'] / d['total'] * 100 if d['total'] else 0,
            'total': d['total'],
        })
    return out

sectors_data = sector_breakdown()
weak_sectors   = sorted(sectors_data, key=lambda x: x['avg_chg'])[:3]
strong_sectors = sorted(sectors_data, key=lambda x: x['avg_chg'], reverse=True)[:3]

def weak_sector_names(max_neg=2):
    """Names of top weak sectors (only those actually negative)"""
    names = [s['name'] for s in weak_sectors if s['avg_chg'] < -0.1][:max_neg]
    return ', '.join(names) if names else ''

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
    # Labels match the dashboard's MCC classification
    if s is None:      return ('—','—','—','neutral')
    if s >= 80:        return ('שורי',        'נמוך',      'חשיפה רחבה',        'bullish')
    if s >= 65:        return ('חיובי זהיר', 'בינוני',    'להתמקד בחזקות',     'constructive')
    if s >= 45:        return ('ניטרלי',      'בינוני',    'לבחור בקפידה',     'neutral')
    if s >= 30:        return ('זהירות',       'גבוה',      'להקטין חשיפה',    'caution')
    return              ('סיכון גבוה',        'גבוה מאוד','להגן / מזומן',     'riskoff')

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
    """
    Two short sentences in plain Hebrew:
      lead = what's happening now
      tail = the main tension or confirmation — what to actually watch
    Avoid jargon. Speak in concrete everyday terms.
    """
    # Lead — describe current state in plain language (no 'אבל' — tail will add tension)
    if state_key == 'bullish':
        lead = 'השוק במגמה עולה חזקה ורוב המניות משתתפות'
    elif state_key == 'constructive':
        lead = 'השוק במגמה חיובית'
    elif state_key == 'neutral':
        lead = 'השוק ללא כיוון ברור — נע בצדדים'
    elif state_key == 'caution':
        lead = 'השוק נחלש ויש סימני לחץ על המחירים'
    else:  # riskoff
        lead = 'השוק בירידה רחבה — לחץ המכירות חזק'

    # Tail — explain tension if present, or reinforce if clean
    tensions = []
    if len(last25) >= 5 and dist_days >= 4:
        weak_names = weak_sector_names(2)
        if weak_names:
            tensions.append(f'אבל יש לחץ מכירות בחלק מהסקטורים — בעיקר ב-{weak_names}')
        else:
            tensions.append(f'אבל ברוב הסשנים היו {dist_days} ימי ירידה רחבה — כסף גדול מתחיל למכור')
    if t_score is not None and f_score is not None and t_score - f_score >= 25:
        tensions.append('אבל הכסף הגדול לא אופטימי כמו המחיר — קונים הגנות')
    elif f_score is not None and t_score is not None and f_score - t_score >= 25:
        tensions.append('אבל המחיר עדיין לא עלה — הכסף מקדים')
    if vix is not None and vix > 22 and state_key in ('bullish','constructive'):
        tensions.append(f'אבל מדד הפחד VIX עולה ({vix:.0f}) — תנודתיות גוברת')
    if flow and flow['pc_p'] is not None and flow['pc_p'] > 1.2 and state_key in ('bullish','constructive'):
        tensions.append('אבל קונים הרבה הגנות — חשש מתיקון')

    if tensions:
        tail = tensions[0]
    elif state_key == 'bullish':
        tail = 'הכסף הגדול תומך והמגמה נקייה'
    elif state_key == 'constructive':
        tail = 'המגמה תומכת אבל כדאי לעקוב'
    elif state_key == 'neutral':
        tail = 'עדיף להמתין לכיוון ברור'
    elif state_key == 'caution':
        tail = 'להיזהר מלהוסיף חשיפה'
    else:
        tail = 'עדיף לשבת בצד ולחכות להתבהרות'

    return f'{lead}. {tail}.'

# ═══════════════════════════════════════════════════
#  Section 2 — Key signals (short, trader-voice)
# ═══════════════════════════════════════════════════
def key_signals():
    items = []
    # 1. SPX vs moving averages — trend position
    if spx and spx['price']:
        ok = sum(1 for v in (spx['ma20'], spx['ma50'], spx['ma200']) if v and spx['price'] > v)
        if ok == 3:
            items.append('המדד מעל כל שלושת קווי המגמה — מגמה יציבה')
        elif ok == 2:
            items.append('המדד מעל 2 מתוך 3 קווי מגמה — מגמה חלקית')
        elif ok == 1:
            items.append('המדד מעל קו מגמה אחד — מגמה חלשה')
        else:
            items.append('המדד מתחת לכל קווי המגמה — מגמה שלילית')
    # 2. MA alignment — long-term trend quality
    if spx and spx['ma20'] and spx['ma50'] and spx['ma200']:
        if spx['ma20'] > spx['ma50'] > spx['ma200']:
            items.append('קווי המגמה מסודרים חיובי — מגמה ארוכת-טווח חזקה')
        elif spx['ma20'] < spx['ma50'] < spx['ma200']:
            items.append('קווי המגמה מסודרים שלילי — מגמה ארוכת-טווח יורדת')
    # 3. Distribution days — contextualize with today's weakest sectors
    if len(last25) >= 5 and dist_days >= 4:
        weak_names = weak_sector_names(2)
        if weak_names:
            items.append(f'{dist_days} ימי ירידה רחבה בחודש — החולשה מרוכזת ב-{weak_names}')
        else:
            items.append(f'{dist_days} ימי ירידה רחבה בחודש — רוב המניות חלשות מול SPX')
    # 4. Options premium — where the BIG money goes
    if flow and flow['pc_p'] is not None:
        if flow['pc_p'] < 0.70:
            items.append('הכסף הגדול משקיע הרבה יותר בעליות מאשר בהגנות — אופטימי מאוד')
        elif flow['pc_p'] < 1.00:
            items.append('הכסף הגדול נוטה לעליות — אופטימיות מתונה')
        elif flow['pc_p'] < 1.30:
            items.append('הכסף הגדול מחלק שווה בין עליות להגנות — ללא כיוון')
        else:
            items.append('הכסף הגדול קונה יותר הגנות מעליות — חששות')
    # 5. Trades (retail crowd direction)
    if flow and flow['pc_tr'] is not None:
        if flow['pc_tr'] < 0.70:
            items.append('גם הציבור הרחב קונה בעיקר עליות — אופטימיות רחבה')
        elif flow['pc_tr'] >= 1.30:
            items.append('הציבור הרחב קונה בעיקר הגנות — חושש')
    # Divergences override (show as a bullet at the end if clear)
    if t_score is not None and f_score is not None:
        if t_score >= 65 and f_score < 45:
            items.append('⚠ המחיר חזק אבל הכסף הגדול לא מאשר — זהירות')
        elif t_score < 45 and f_score >= 65:
            items.append('⚠ הכסף הגדול שורי אבל המחיר חלש — אי-התאמה')
    return items[:5]

def signals_conclusion():
    """One punchy line — what it all means together"""
    if flow is None or m_score is None or f_score is None or t_score is None: return ''
    # Price strong, money cautious
    if t_score - f_score >= 25:
        return 'המחיר חזק אבל הכסף הגדול מתחיל להיזהר — העלייה עלולה להיעצר'
    # Money strong, price lagging
    if f_score - t_score >= 25:
        return 'הכסף הגדול שורי, אבל המחיר עדיין לא מאשר — יכול להיות תחילה של מהלך'
    # Everything aligned up
    if f_score >= 70 and m_score >= 65:
        return 'כל הסימנים חיוביים — מגמה חזקה'
    # Everything aligned down
    if f_score < 40 and m_score < 40:
        return 'כל הסימנים שליליים — סביבה קשה'
    # Hedges demand elevated
    if flow['pc_p'] is not None and flow['pc_p'] > 1.30:
        return 'ביקוש הגנות גבוה — השוק חושש מתיקון'
    # Flow strong but market broader not
    if f_score >= 65 and m_score < 50:
        return 'הכסף הגדול תומך, אבל רק מעט מניות עולות — מהלך צר'
    # Default
    return 'הסימנים מעורבים — עדיף לעקוב ולא לפעול'

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

def is_rebound(s):
    """
    Rebound candidate: oversold OR weak-RSI + has at least one MA support + volume spike + actually pulled back.
    Logic: stock is beaten down but institutions may be accumulating.
    """
    return (s['rsi'] in ('Below 30','New Below 30','Below 50','New Below 50')
            and s['ma_score'] >= 1
            and s['rvol'] > 1.2
            and s['w52'] < -15)

def rebound_score(s):
    """Rank rebound candidates — prefer deep oversold with strong volume"""
    sc = 0
    if s['rsi'] in ('Below 30','New Below 30'): sc += 30  # deeper oversold
    elif s['rsi'] in ('Below 50','New Below 50'): sc += 15
    sc += min(s['rvol'], 5) * 10                          # volume confirmation (up to 50)
    sc += s['ma_score'] * 5                               # MA support intact
    if s['chg'] is not None and s['chg'] > 0: sc += 10    # turning up today
    return sc

def rebound_meaning(s):
    rvol = s['rvol']
    if s['rsi'] in ('Below 30','New Below 30') and rvol > 2:
        return 'מכירת יתר עמוקה + נפח חריג'
    if s['rsi'] in ('Below 30','New Below 30'):
        return 'מכירת יתר — קצה התחתית'
    if rvol > 2.5:
        return 'נפח גבוה — מוסדיים נכנסים'
    if s['chg'] is not None and s['chg'] > 1:
        return 'מכירת יתר + מתחילה להתהפך'
    if s['ma_score'] >= 2:
        return 'נחלשה אך מחזיקה תמיכות'
    return 'מכירת יתר — נפח מצטבר'

strong   = sorted(stocks, key=momentum, reverse=True)[:5]
weak     = sorted(stocks, key=weakness, reverse=True)[:5]
rebound  = sorted([s for s in stocks if is_rebound(s)], key=rebound_score, reverse=True)[:5]

# ═══════════════════════════════════════════════════
#  Section 5 — alerts (only if relevant)
# ═══════════════════════════════════════════════════
def alerts():
    al = []
    if vix is not None and vix > 25:
        al.append('מדד הפחד VIX גבוה — השוק מתנדנד חזק')
    if flow and flow['pc_p'] is not None and flow['pc_p'] > 1.30:
        al.append('קונים הרבה הגנות — הקהל חושש מירידה')
    if len(last25) >= 5 and dist_days >= 5:
        weak_names = weak_sector_names(2)
        if weak_names:
            al.append(f'{dist_days} ימי ירידה רחבה — חולשה מתרכזת ב-{weak_names}')
        else:
            al.append(f'{dist_days} ימי ירידה רחבה — מוסדיים מוכרים בחלק מהסקטורים')
    if t_score is not None and f_score is not None and abs(t_score - f_score) >= 30:
        al.append('המחיר והכסף הגדול לא מסתדרים — אי-התאמה משמעותית')
    if nl >= 30 and nh_nl < 0.5 and nh_nl != 99:
        al.append(f'{nl} מניות רחוקות מהשיא שלהן — חולשה רחבה')
    return al[:3]

alerts_list = alerts()

# ═══════════════════════════════════════════════════
#  Section 6 — Action line
# ═══════════════════════════════════════════════════
def action_line():
    if c_score is None: return '—'
    if c_score >= 80: return 'מגמה תומכת — אפשר להגדיל חשיפה בהדרגה'
    if c_score >= 65: return 'להתמקד במניות חזקות, לא לקנות הכל'
    if c_score >= 45: return 'לבחור בקפידה, לא להתפזר על הרבה מניות'
    if c_score >= 30: return 'להקטין סיכון, לא להוסיף פוזיציות'
    return 'עדיף לשבת בצד ולחכות להתבהרות'

# ═══════════════════════════════════════════════════
#  Date label
# ═══════════════════════════════════════════════════
date_label = ''
if hist_files:
    raw = os.path.basename(hist_files[-1]).replace('watchlist-sp-500-intraday-','').replace('.csv','')
    # Filename format is MM-DD-YYYY; convert to Israeli DD-MM-YYYY
    parts = raw.split('-')
    if len(parts) == 3:
        date_label = f'{parts[1]}-{parts[0]}-{parts[2]}'
    else:
        date_label = raw

# ═══════════════════════════════════════════════════
#  HTML build
# ═══════════════════════════════════════════════════
def score_qualifier(v):
    """One-word description of the score's magnitude."""
    if v is None: return '—'
    if v >= 80: return 'חזק מאוד'
    if v >= 65: return 'חזק'
    if v >= 45: return 'בינוני'
    if v >= 30: return 'חלש'
    return 'שלילי'

def score_block(lbl, v, desc=''):
    if v is None:
        color = '#cbd5e0'; txt = '—'
    else:
        color = '#10b981' if v >= 65 else '#f59e0b' if v >= 45 else '#ef4444'
        txt = str(v)
    qual = score_qualifier(v)
    desc_html = (f'<div style="font-size:10px;color:#94a3b8;margin-top:6px;line-height:1.35;text-align:center;">{desc}</div>'
                 if desc else '')
    return (f'<td align="center" style="padding:14px 8px 12px;text-align:center;width:33%;vertical-align:top;">'
            f'<div style="font-size:11px;color:#4a5568;font-weight:600;margin-bottom:6px;text-align:center;">{lbl}</div>'
            f'<div style="font-size:26px;font-weight:700;color:{color};line-height:1;text-align:center;">{txt}</div>'
            f'<div style="font-size:10px;color:{color};font-weight:600;margin-top:4px;text-align:center;">{qual}</div>'
            f'{desc_html}'
            f'</td>')

def scores_interpretation():
    """One plain-language line explaining what the three scores together mean."""
    if None in (m_score, t_score, f_score): return ''
    # Common tension: index strong, breadth or money less so
    if t_score >= 80 and m_score < 55:
        return 'המדד חזק, אבל רק חלק קטן מהמניות עולות — המהלך נישא ע״י מעטות'
    if t_score >= 80 and f_score < 50:
        return 'המדד חזק, אבל הכסף הגדול לא רודף — סימן זהירות'
    if all(s >= 65 for s in (m_score, t_score, f_score)):
        return 'כל שלושת הציונים חזקים — מגמה תומכת בכל החזיתות'
    if all(s < 45 for s in (m_score, t_score, f_score)):
        return 'כל שלושת הציונים חלשים — שוק מאתגר'
    if m_score < 45 and t_score >= 65:
        return 'המדד חזק אבל רוב המניות פחות — להיזהר מהכללה'
    return 'תמונה מעורבת — כדאי לעקוב לפני פעולה'

def stock_row(s, kind='strong'):
    """kind: 'strong' | 'weak' | 'rebound' — determines meaning + color"""
    if kind == 'strong':
        meaning = strong_meaning(s); meaning_color = '#2f855a'
    elif kind == 'rebound':
        meaning = rebound_meaning(s); meaning_color = '#b7791f'  # amber/gold
    else:
        meaning = weak_meaning(s); meaning_color = '#c53030'
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

scores_interp_text = scores_interpretation()
scores_interp_html = (f'<div dir="rtl" style="margin-top:12px;padding:8px 12px;background:#f7fafc;border-right:3px solid {accent};font-size:12px;color:#2d3748;line-height:1.5;text-align:right;">{scores_interp_text}</div>'
                      if scores_interp_text else '')

s3_html = f"""
<div dir="rtl" style="{CARD}padding:20px 22px;text-align:right;">
  <div style="font-size:11px;color:#718096;letter-spacing:0.1em;text-transform:uppercase;font-weight:600;margin-bottom:12px;text-align:right;">נתוני שוק</div>
  <table dir="rtl" style="width:100%;border-collapse:collapse;border:1px solid #edf2f7;border-radius:8px;overflow:hidden;background:#f7fafc;direction:rtl;">
    <tr>
      {score_block('רוחב השוק', m_score, 'כמה מניות משתתפות במגמה')}
      {score_block('כוח המדד', t_score, 'הטכניקה של SPX עצמו')}
      {score_block('זרימת כסף', f_score, 'לאן זורם כסף מוסדי באופציות')}
    </tr>
  </table>
  {scores_interp_html}
  <table dir="rtl" style="width:100%;font-size:13px;color:#2d3748;margin-top:14px;border-collapse:collapse;direction:rtl;">
    <tr style="background:#f7fafc;">
      <td align="right" style="padding:8px 12px;color:#718096;width:110px;text-align:right;">SPX</td>
      <td align="right" style="padding:8px 12px;font-weight:600;font-variant-numeric:tabular-nums;text-align:right;"><span dir="ltr" style="unicode-bidi:isolate;">{spx_price_str}</span> <span dir="ltr" style="color:{spx_chg_color};font-weight:600;unicode-bidi:isolate;">{spx_chg_str}</span></td>
      <td align="right" style="padding:8px 12px;color:#718096;width:110px;text-align:right;">מדד הפחד VIX</td>
      <td align="right" style="padding:8px 12px;font-weight:600;text-align:right;"><span dir="ltr" style="unicode-bidi:isolate;">{vix_str}</span></td>
    </tr>
    <tr>
      <td align="right" style="padding:8px 12px;color:#718096;text-align:right;">מניות מעל ממוצע 200 יום</td>
      <td align="right" style="padding:8px 12px;font-weight:600;text-align:right;"><span dir="ltr" style="unicode-bidi:isolate;">{int(p200)}% ({a200}/{total})</span></td>
      <td align="right" style="padding:8px 12px;color:#718096;text-align:right;">חזקות / חלשות</td>
      <td align="right" style="padding:8px 12px;font-weight:600;text-align:right;"><span dir="ltr" style="unicode-bidi:isolate;">{nh} / {nl}</span></td>
    </tr>
  </table>
</div>
"""

strong_rows  = ''.join(stock_row(s, 'strong') for s in strong)
weak_rows    = ''.join(stock_row(s, 'weak') for s in weak)
rebound_rows = ''.join(stock_row(s, 'rebound') for s in rebound)
rebound_section_html = (f'''<tr style="background:#fffbeb;"><td align="right" colspan="2" style="padding:8px 10px;font-size:12px;color:#b7791f;font-weight:700;text-align:right;">↺ מועמדות לריבאונד</td></tr>
    <tr><td align="right" colspan="2" style="padding:2px 10px 6px;font-size:11px;color:#92400e;text-align:right;font-style:italic;">מניות במכירת יתר עם נפח שעולה — עשויות להתהפך</td></tr>
    {rebound_rows}''' if rebound else '')

s4_html = f"""
<div dir="rtl" style="{CARD}padding:20px 22px;text-align:right;">
  <div style="font-size:11px;color:#718096;letter-spacing:0.1em;text-transform:uppercase;font-weight:600;margin-bottom:12px;text-align:right;">מניות — חוזק / חולשה / ריבאונד</div>
  <table dir="rtl" style="width:100%;border-collapse:collapse;direction:rtl;">
    <tr style="background:#f0fdf4;"><td align="right" colspan="2" style="padding:8px 10px;font-size:12px;color:#2f855a;font-weight:700;text-align:right;">▲ חזקות</td></tr>
    {strong_rows}
    <tr style="background:#fef2f2;"><td align="right" colspan="2" style="padding:8px 10px;font-size:12px;color:#c53030;font-weight:700;text-align:right;">▼ חלשות</td></tr>
    {weak_rows}
    {rebound_section_html}
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
        <td align="right" style="vertical-align:middle;width:128px;text-align:right;padding:4px 0;">
          <img src="https://nditzik.github.io/indexes-status/logo-v2.png" alt="Logo" width="112" height="auto" style="display:block;height:auto;width:112px;max-width:112px;border:0;">
        </td>
        <td align="right" style="vertical-align:middle;padding-right:0;padding-left:14px;text-align:right;">
          <div style="font-size:11px;opacity:0.7;letter-spacing:0.15em;text-transform:uppercase;margin-bottom:4px;text-align:right;">Daily Briefing</div>
          <div style="font-size:18px;font-weight:600;text-align:right;">S&amp;P 500 · {date_label}</div>
        </td>
        <td align="left" style="vertical-align:middle;text-align:left;">
          <a href="https://nditzik.github.io/indexes-status/" style="color:#fff;background:#3b82f6;padding:6px 12px;border-radius:6px;font-size:11px;text-decoration:none;font-weight:500;white-space:nowrap;">דשבורד ←</a>
        </td>
      </tr>
    </table>
  </div>

  <!-- Disclaimer — red bold, RTL -->
  <div dir="rtl" style="padding:14px 20px;margin-bottom:12px;background:#fef2f2;border-radius:8px;border-right:4px solid #dc2626;text-align:right;direction:rtl;">
    <p style="margin:0;color:#dc2626;font-size:13px;font-weight:700;line-height:1.55;text-align:right;direction:rtl;">
      הדשבורד נבנה על ידי איציק נידם עם לוגו הזרע העיראקי השעיר ונועד לצרכים אישיים בלבד. וברוך הבא אסף נבות.
    </p>
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
        {"email": "ofeknidam@gmail.com"},
        {"email": "anavot70@gmail.com"}
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
