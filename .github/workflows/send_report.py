"""
Daily Market Briefing Email
===========================
Structured 6-section brief, readable in under 60 seconds.
Replicates the dashboard's scoring logic (MCC, Technical, Options Flow)
and renders as a compact HTML email sent via Brevo on every CSV push.
"""

import csv, json, os, urllib.request, urllib.error, glob, io, hashlib
from datetime import date as _date

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

# Exclude split anomalies AND prefer RSP if present in watchlist.
# stocks[] already excludes $-prefixed symbols, but RSP would be there.
# We pull it out for direct use as the equal-weight benchmark.
rsp_obj = next((s for s in stocks if s['sym'] == 'RSP'), None)
chg_vals = [s['chg'] for s in stocks
            if s['sym'] != 'RSP' and s['chg'] is not None and abs(s['chg']) < 50]
if rsp_obj and rsp_obj['chg'] is not None and abs(rsp_obj['chg']) < 50:
    avg_change = rsp_obj['chg']
else:
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

def sector_heatmap_rows_html():
    """Returns HTML <tr> rows — one per sector, ordered best→worst by
    today's avg %change, background tinted by performance bucket.
    Five buckets: strong-green / light-green / neutral / amber / red."""
    rows = sorted(sectors_data, key=lambda x: -x['avg_chg'])
    out = []
    for s in rows:
        avg = s['avg_chg']
        if avg >= 0.5:
            bg, color = '#d1fae5', '#065f46'
        elif avg >= 0.1:
            bg, color = '#ecfdf5', '#047857'
        elif avg >= -0.1:
            bg, color = '#f7fafc', '#4a5568'
        elif avg >= -0.5:
            bg, color = '#fef3c7', '#92400e'
        else:
            bg, color = '#fee2e2', '#991b1b'
        sign = '+' if avg >= 0 else ''
        out.append(
            f'<tr style="background:{bg};">'
            f'<td align="right" style="padding:7px 12px;color:{color};font-weight:600;font-size:13px;text-align:right;">{s["name"]}</td>'
            f'<td align="left" dir="ltr" style="padding:7px 12px;color:{color};font-family:monospace;font-weight:700;font-size:13px;text-align:left;">{sign}{avg:.2f}%</td>'
            f'<td align="right" style="padding:7px 12px;color:#718096;font-size:11px;text-align:right;width:80px;">{s["total"]} מניות</td>'
            f'</tr>'
        )
    return '\n'.join(out)

def historical_patterns_text():
    """Read the latest forward-tracking snapshot and produce a one-line
    Hebrew digest of the 20-day forward outcomes across the K analogs.
    Returns None if the snapshot file is missing/empty — caller hides
    the block in that case."""
    try:
        with open('data/forward_snapshots.json', 'r', encoding='utf-8') as f:
            data = json.load(f)
        snaps = data.get('snapshots') or []
        if not snaps:
            return None
        snap = snaps[-1]
        out20 = (snap.get('outcomes') or {}).get('20') or {}
        n = out20.get('samples', 0)
        if not n:
            return None
        median = out20.get('median', 0)
        mn = out20.get('min', 0)
        mx = out20.get('max', 0)
        hit = out20.get('hitRate', 0)
        ms = '+' if median >= 0 else ''
        mns = '+' if mn >= 0 else ''
        mxs = '+' if mx >= 0 else ''
        return (
            f'{n} אנלוגים בעבר → 20 ימים: '
            f'חציון {ms}{median:.2f}%, '
            f'טווח {mns}{mn:.2f}% עד {mxs}{mx:.2f}%, '
            f'{round(hit*100)}% חיובי. מותנה בהמשך משטר יציב.'
        )
    except Exception as e:
        print(f'Historical patterns load error: {e}')
        return None

historical_patterns_str = historical_patterns_text()

# ═══════════════════════════════════════════════════
#  Historical data — last ~365 trading days (richer than the old
#  "avg-only" history). Each entry carries date + avg_change +
#  spx_chg_pct + pctMa200 + spx.{price,ma200} so the narrative,
#  selling-day rule, and broad-uptrend duration can all read from
#  the same source. Older code used a flat list of avg values only.
# ═══════════════════════════════════════════════════
hist_files = sorted(glob.glob('data/watchlist-sp-500-intraday-*.csv'))

def parse_history_day(hf):
    """Parse one CSV → dict with the fields the narrative needs.
    Returns None if the file is unparseable or contains no stock rows."""
    try:
        rows = load_csv(hf)
    except Exception as e:
        print(f'History load skip {hf}: {e}')
        return None
    spx_row = None
    stock_chgs = []
    total_stocks = 0
    above_ma200 = 0
    for r in rows:
        sym = (r.get('Symbol') or '').strip()
        if not sym: continue
        if sym == '$SPX':
            spx_row = r
            continue
        if sym.startswith('$'): continue
        latest = num(r.get('Latest'))
        if latest is None or latest <= 0: continue
        chg = num(r.get('%Change'))
        # Skip RSP from stock_chgs — we'll use it directly below if present
        if sym == 'RSP':
            continue
        # Exclude split anomalies (see overview-prod.js note on RSP parity)
        if chg is not None and chg != 0 and abs(chg) < 50:
            stock_chgs.append(chg)
        ma200 = num(r.get('200D MA'))
        total_stocks += 1
        if ma200 and latest > ma200:
            above_ma200 += 1
    if not stock_chgs:
        return None
    # Re-scan for RSP (cleaner than tracking inside the loop)
    rsp_chg = None
    try:
        with open(hf, 'r', encoding='utf-8') as f2:
            for row in csv.DictReader(f2):
                if (row.get('Symbol') or '').strip() == 'RSP':
                    rsp_chg = num(row.get('%Change'))
                    break
    except Exception:
        pass
    eq_change = (rsp_chg
                 if rsp_chg is not None and abs(rsp_chg) < 50
                 else sum(stock_chgs) / len(stock_chgs))
    # Date from filename
    base = os.path.basename(hf).replace('watchlist-sp-500-intraday-','').replace('.csv','')
    # Filename is MM-DD-YYYY → ISO YYYY-MM-DD
    mp = base.split('-')
    iso = f'{mp[2]}-{mp[0]}-{mp[1]}' if len(mp) == 3 else base
    return {
        'date': iso,
        'avg_change': eq_change,
        'spx_chg_pct': num(spx_row.get('%Change')) if spx_row else None,
        'spx_price':   num(spx_row.get('Latest'))  if spx_row else None,
        'spx_ma200':   num(spx_row.get('200D MA')) if spx_row else None,
        'pct_ma200':   above_ma200 / total_stocks * 100 if total_stocks else 0,
    }

history_rich = [d for d in (parse_history_day(hf) for hf in hist_files[-365:]) if d]
# Back-compat shim — older code expected `history` (list of avg values)
# and `last25` / `last5` (lists of avg values). Preserve the names.
history = [d['avg_change'] for d in history_rich]
last25_rich = history_rich[-25:]
last10_rich = history_rich[-10:]
last5_rich  = history_rich[-5:]
last25 = history[-25:]
last5  = history[-5:]

def is_selling_day(d):
    """Mirrors overview-prod.js (lines 873-878):
       primary rule SPX < -0.5%, fallback avg < -0.7% when SPX row absent.
       Replaces the old 'avg < -0.2' which over-counted by ~5x."""
    spx = d.get('spx_chg_pct')
    if spx is not None and isinstance(spx, float):
        return spx < -0.5
    avg = d.get('avg_change')
    return avg is not None and avg < -0.7

dist_days        = sum(1 for d in last25_rich if is_selling_day(d))
sell_days_10     = sum(1 for d in last10_rich if is_selling_day(d))
weekly_change    = sum(history[-5:]) if len(history) >= 3 else None

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
    # Labels match the dashboard's strip exactly (overview-prod.js
    # renderStrip @ lines 1107-1121): מצוין / בריא / זהיר / מוחלש / שלילי.
    # Previous labels (שורי / חיובי זהיר / ניטרלי / זהירות / סיכון גבוה)
    # diverged from the dashboard wording and confused users who compared
    # the email to the website.
    if s is None:      return ('—',        '—',        '—',                 'neutral')
    if s >= 75:        return ('מצוין',    'נמוך',     'חשיפה רחבה',         'bullish')
    if s >= 60:        return ('בריא',     'בינוני',   'להתמקד בחזקות',     'constructive')
    if s >= 45:        return ('זהיר',     'בינוני',   'לבחור בקפידה',      'neutral')
    if s >= 30:        return ('מוחלש',    'גבוה',     'להקטין חשיפה',      'caution')
    return              ('שלילי',    'גבוה מאוד','להגן / מזומן',       'riskoff')

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
#  Narrative replication — mirror of v2/narrative.js v2.0
#  Produces the same 5-block story shown on the dashboard:
#    headline (meta-label + rationale) · today · week · background · watchFor
#
#  Kept in sync with narrative.js by convention — when the JS changes,
#  mirror the change here (and vice versa). Both files reference each
#  other in comments at the top so the relationship is discoverable.
# ═══════════════════════════════════════════════════

def cumulative_spread(history_rich_arg, days=5):
    """Sum of (avg - spx_chg) over the last N hist days. None if no overlap."""
    if not history_rich_arg: return None
    window = history_rich_arg[-days:]
    total, counted = 0.0, 0
    for d in window:
        avg = d.get('avg_change')
        spx_chg = d.get('spx_chg_pct')
        if avg is None or spx_chg is None: continue
        total += (avg - spx_chg)
        counted += 1
    return None if counted == 0 else total

def count_spx_above_ma200(history_rich_arg):
    """Consecutive recent days where SPX closed above MA200. Mirror of
       countSpxAboveMa200() in v2/narrative.js."""
    if not history_rich_arg: return 0
    count = 0
    for d in reversed(history_rich_arg):
        price = d.get('spx_price')
        ma200 = d.get('spx_ma200')
        if not price or not ma200: break
        if not (price > ma200): break
        count += 1
    return count

# ─── Phase classifier — minimal port of regime.js ─────────────────
# Only covers the phases the email needs: confirmed_uptrend,
# uptrend_pressure, correction, capitulation. Distribution and
# base_building require breadth5dDelta computed over richer data
# (loadable but tangential for the email's purpose).
PHASE_LABELS = {
    'confirmed_uptrend': 'מגמה חיובית מאושרת',
    'uptrend_pressure':  'מגמה תחת לחץ',
    'correction':        'תיקון רחב',
    'capitulation':      'שיא הפחד',
    'distribution':      'הפצה פעילה',
    'base_building':     'בניית בסיס',
    'thrust':            'פריצה ראשונית',
}

def classify_phase(m):
    """m = dict with combined, distributionDays, vix, nhMinusNl."""
    combined_v = m.get('combined')
    dist = m.get('distributionDays', 0)
    vix_v  = m.get('vix') or 0
    nhnl = m.get('nhMinusNl', 0)
    if combined_v is None:
        return 'uptrend_pressure'
    if combined_v < 30 and vix_v > 30 and nhnl < -50:
        return 'capitulation'
    if combined_v < 40 and vix_v > 22:
        return 'correction'
    if combined_v >= 70 and dist <= 2 and vix_v < 20:
        return 'confirmed_uptrend'
    return 'uptrend_pressure'

def phase_criteria_descriptor(phase_id, m):
    """Hebrew description of the criteria values that anchor each phase.
       Mirror of phaseCriteriaDescriptor() in v2/narrative.js."""
    if phase_id == 'confirmed_uptrend':
        return (f'בריאות {m["combined"]}, VIX {m["vix"]:.1f}, '
                f'ימי מכירה {m["distributionDays"]} בלבד מתוך 25')
    if phase_id == 'uptrend_pressure':
        return f'ציון בריאות {m["combined"]}, VIX {m["vix"]:.1f}'
    if phase_id == 'correction':
        return f'ציון {m["combined"]}, VIX {m["vix"]:.1f}'
    if phase_id == 'capitulation':
        return (f'VIX {m["vix"]:.1f}, ציון {m["combined"]}, '
                f'שיאי שפל {abs(m.get("nhMinusNl", 0))}')
    return None

# ─── Driver phrases for the headline ──────────────────────────────
def recent_driver_phrase(metrics, history_rich_arg):
    s5 = cumulative_spread(history_rich_arg, 5)
    bd = metrics.get('breadth5dDelta')
    if s5 is not None and s5 > 1.5:
        return f'רוחב מתחזק חזק (+{s5:.1f}% השבוע)'
    if s5 is not None and s5 > 0.5:
        return f'רוחב משתפר (+{s5:.1f}% השבוע)'
    if bd is not None and bd > 5:
        return f'אחוז המניות מעל MA200 עלה ב-{bd:.1f}% בשבוע'
    return 'תנועה חיובית קצרת-טווח'

def regime_driver_phrase(metrics):
    dist = metrics.get('distributionDays', 0)
    dist_recent = metrics.get('sellDaysRecent10', 0)
    p200 = metrics.get('pctMa200', 0)
    vix_v = metrics.get('vix') or 0
    nhnl = metrics.get('nhMinusNl', 0)
    if dist_recent is not None and dist_recent >= 3:
        return f'{dist_recent} ימים שליליים חזקים ב-10 ימים אחרונים (אשכול טרי)'
    if dist >= 5:
        return f'{dist} ימים שליליים חזקים ב-25 ימים אחרונים'
    if p200 < 30:
        return f'רק {round(p200)}% מהמניות מעל MA200'
    if vix_v > 25:
        return f'VIX {vix_v:.1f} (מעל סף הפאניקה)'
    if nhnl <= -50:
        return f'{nhnl} שיאים-שפלים נטו (חריג שלילי)'
    if p200 < 50:
        return f'רוחב טווח-ארוך חלש ({round(p200)}% מעל MA200)'
    return 'הפאזה הטכנית עדיין שלילית'

# ─── 5 narrative builders ─────────────────────────────────────────
def build_headline(metrics, history_rich_arg, phase_id):
    """Returns (meta_label, rationale) per the headline matrix in
       v2/narrative.js lines 142-201."""
    regime_class = 'pos' if phase_id in ('confirmed_uptrend','uptrend_pressure','thrust') else (
                    'neg' if phase_id in ('correction','capitulation','distribution') else 'warn')
    s5 = cumulative_spread(history_rich_arg, 5) or 0
    bd = metrics.get('breadth5dDelta') or 0
    recent_score = s5 * 0.5 + bd * 0.05
    recent_pos = recent_score > 0.5
    recent_neg = recent_score < -0.5
    if regime_class == 'pos':
        if recent_pos:
            return ('ראלי חזק',
                    f'המגמה הטכנית חיובית והרוחב מתחזק '
                    f'({recent_driver_phrase(metrics, history_rich_arg)})')
        if recent_neg:
            sp = cumulative_spread(history_rich_arg, 5)
            spread_txt = f'הרוחב נחלש ({sp:.1f}% השבוע)' if sp is not None else 'הרוחב נחלש'
            return ('חולשה מתהווה',
                    f'המגמה הטכנית עדיין חיובית אבל {spread_txt}')
        return ('מגמה יציבה',
                'המגמה הטכנית חיובית, אין סטייה משמעותית השבוע')
    if regime_class == 'neg':
        if recent_pos:
            return ('מצב מעורב',
                    recent_driver_phrase(metrics, history_rich_arg) + ' אבל '
                    + regime_driver_phrase(metrics))
        if recent_neg:
            return ('אזהרה מסלימה',
                    f'{regime_driver_phrase(metrics)} בנוסף לחולשה השבוע')
        return ('מגמה תחת לחץ',
                f'{regime_driver_phrase(metrics)} (יציב, ללא הסלמה)')
    # warn / muted
    if recent_pos:
        return ('שיפור מתהווה',
                f'{recent_driver_phrase(metrics, history_rich_arg)} — '
                'המגמה הטכנית ארוכת-הטווח עדיין לא אישרה')
    if recent_neg:
        sp = cumulative_spread(history_rich_arg, 5)
        spread_txt = f'(פער 5d {sp:.1f}%)' if sp is not None else ''
        return ('התייצבות שברירית',
                f'הרוחב מתרופף השבוע {spread_txt} ללא תמיכה מצד המגמה הטכנית')
    return ('התייצבות', 'אין כיוון מבוסס — לא חיובי ולא שלילי')

def build_today(metrics):
    """Mirror of buildToday() in v2/narrative.js."""
    avg = metrics.get('avgChange')
    spx_chg = metrics.get('spxChgPct')
    if avg is None or spx_chg is None: return 'אין נתוני יום נוכחי.'
    avg_verb = 'עלה' if avg >= 0 else 'ירד'
    spx_verb = 'עלה' if spx_chg >= 0 else 'ירד'
    cyc = metrics.get('cyclicalLeadership')
    deff = metrics.get('defensiveLeadership')
    sector_tail = ''
    if cyc is not None and cyc >= 0.67:
        sector_tail = ', סקטורי-צמיחה מובילים — סנטימנט אופטימי'
    elif deff is not None and deff >= 0.67:
        sector_tail = ', סקטורים הגנתיים מובילים — סנטימנט זהיר'
    elif cyc is not None and deff is not None:
        if cyc > deff + 0.1:
            sector_tail = ', נטייה חיובית — סקטורי צמיחה מובילים'
        elif deff > cyc + 0.1:
            sector_tail = ', נטייה זהירה — סקטורי הגנה מובילים'
    return (f'המדד השוויוני {avg_verb} {abs(avg):.2f}% '
            f'בעוד המדד {spx_verb} {abs(spx_chg):.2f}%{sector_tail}.')

def build_week(history_rich_arg):
    """Mirror of buildWeek() in v2/narrative.js."""
    s5 = cumulative_spread(history_rich_arg, 5)
    if s5 is None: return 'אין מספיק היסטוריה לחישוב שבועי.'
    mag = abs(s5)
    if s5 > 1.0:
        return f'המדד השוויוני הביס את המדד הקאפ-משוקלל ב-{mag:.1f}% — מגמת השתתפות חיובית.'
    if s5 < -1.0:
        return f'המדד הקאפ-משוקלל הביס את המדד השוויוני ב-{mag:.1f}% — דפוס של ראלי צר, מובל ע"י מעטות.'
    return 'המדד השוויוני והמדד הקאפ-משוקלל בקצב דומה — אין נטייה ברורה.'

def build_background(metrics, history_rich_arg, phase_id):
    """Mirror of buildBackground() in v2/narrative.js — option ג' wording
       (state-based, no 'started today' drama)."""
    phase_label = PHASE_LABELS.get(phase_id, 'לא ידוע')
    descriptor = phase_criteria_descriptor(phase_id, metrics)
    line = (f'מצב השוק: "{phase_label}". כל הקריטריונים יושבים יחד: {descriptor}.'
            if descriptor else f'מצב השוק: "{phase_label}".')
    if phase_id in ('confirmed_uptrend','uptrend_pressure','thrust'):
        broad = count_spx_above_ma200(history_rich_arg)
        if broad >= 30:
            line += f' השוק במגמה חיובית (SPX מעל MA200) כבר {broad} ימי מסחר — תקופה ארוכה.'
        elif broad >= 5:
            line += f' השוק במגמה חיובית (SPX מעל MA200) {broad} ימי מסחר אחרונים.'
    # Selling-days tail
    dist = metrics.get('distributionDays', 0)
    recent10 = metrics.get('sellDaysRecent10', 0)
    if recent10 is not None and recent10 >= 3:
        line += f' {recent10} ימים שליליים חזקים ב-10 הימים האחרונים — אשכול טרי, סימן אזהרה.'
    elif dist >= 5:
        rf = f' (מהם {recent10} ב-10 הימים האחרונים)' if recent10 is not None else ''
        line += f' {dist} ימים שליליים חזקים ב-25 ימים אחרונים{rf} — מעל הסף הרגיל.'
    elif dist >= 2:
        rf = f' (מהם {recent10} ב-10 ימים אחרונים)' if recent10 is not None and recent10 > 0 else ''
        line += f' {dist} ימים שליליים חזקים ב-25 ימים אחרונים{rf} — בטווח נורמלי, ללא אשכול חריג.'
    elif dist <= 1:
        line += f' {dist} ימים שליליים חזקים בלבד ב-25 ימים — שוק ללא מכירות בולטות.'
    return line

def build_watch_for(metrics):
    """Mirror of buildWatchFor() in v2/narrative.js, with the 2026-05-25
       VIX bug fix applied."""
    triggers = []
    p50 = metrics.get('pctMa50')
    if p50 is not None:
        if p50 < 50 and p50 > 25:
            triggers.append((1, f'%MA50 חוצה 50% (כעת {round(p50)}%) → הפאזה תשתפר.'))
        elif p50 >= 50 and p50 < 75:
            triggers.append((3, f'%MA50 יורד מתחת ל-50% (כעת {round(p50)}%) → סיכון להידרדרות.'))
    vix_v = metrics.get('vix')
    if vix_v is not None:
        if vix_v < 18:
            triggers.append((3, f'VIX מטפס מעל 18 (כעת {vix_v:.1f}) → התחלת אי-וודאות.'))
        elif vix_v < 22:
            triggers.append((2, f'VIX מטפס מעל 22 (כעת {vix_v:.1f}) → אזהרה חדשה.'))
        else:
            triggers.append((1, f'VIX יורד מתחת ל-18 (כעת {vix_v:.1f}) → רגיעה ובחזרה לסיכון.'))
    dist = metrics.get('distributionDays', 0)
    if dist >= 5:
        triggers.append((1, f'ימי מכירה כבדה יורדים מתחת ל-5 (כעת {dist}) → שיפור פאזה.'))
    nhnl = metrics.get('nhMinusNl', 0)
    if nhnl <= -30:
        triggers.append((2, f'שיאים-שפלים מתאזנים (כעת {nhnl}) → סוף החולשה.'))
    elif nhnl >= 50:
        triggers.append((3, 'שיאים-שפלים יורדים מתחת ל-20 → אובדן מומנטום.'))
    triggers.sort(key=lambda t: t[0])
    return [t[1] for t in triggers[:2]]

# Compose the metrics dict the narrative builders consume.
# Cyclical / defensive leadership are computed from the top-3 sectors
# by avg %change, matching the dashboard's sector classification.
CYCLICAL = {'IT','CD','FIN','IND','MAT','EN','COMM'}
DEFENSIVE = {'HC','CS','UTIL','REIT'}
top3_sectors_data = sorted(sectors_data, key=lambda x: -x['avg_chg'])[:3]
cyclical_lead = (sum(1 for s in top3_sectors_data if s['sec'] in CYCLICAL) /
                 len(top3_sectors_data)) if top3_sectors_data else 0
defensive_lead = (sum(1 for s in top3_sectors_data if s['sec'] in DEFENSIVE) /
                  len(top3_sectors_data)) if top3_sectors_data else 0

narrative_metrics = {
    'combined': c_score,
    'avgChange': avg_change,
    'spxChgPct': spx['chgPct'] if spx else None,
    'vix': vix,
    'distributionDays': dist_days,
    'sellDaysRecent10': sell_days_10,
    'pctMa200': p200,
    'pctMa50':  a50 / total * 100 if total else 0,
    'nhMinusNl': nh - nl,
    'cyclicalLeadership': cyclical_lead,
    'defensiveLeadership': defensive_lead,
    'breadth5dDelta': (history_rich[-1]['pct_ma200'] - history_rich[-6]['pct_ma200'])
                      if len(history_rich) >= 6 else None,
}
phase_id_now = classify_phase(narrative_metrics)
phase_label_now = PHASE_LABELS.get(phase_id_now, 'לא ידוע')
meta_label_now, rationale_now = build_headline(narrative_metrics, history_rich, phase_id_now)
today_line_now      = build_today(narrative_metrics)
week_line_now       = build_week(history_rich)
background_line_now = build_background(narrative_metrics, history_rich, phase_id_now)
watch_for_now       = build_watch_for(narrative_metrics)

# ═══════════════════════════════════════════════════
#  Legacy narrative — kept for backwards-compat if anywhere reads it,
#  but the new email body uses the layered builders above instead.
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

def is_early_bounce(s):
    """
    Above MA20 but below MA50, MA150, MA200 — first sign of recovery in a downtrend.
    Stock has lifted off short-term lows but long-term trend still negative.
    """
    if not all([s['ma20'], s['ma50'], s['ma150'], s['ma200']]):
        return False
    p = s['latest']
    return (p > s['ma20']
            and p < s['ma50']
            and p < s['ma150']
            and p < s['ma200'])

def early_bounce_meaning(s):
    chg = s['chg'] or 0
    if s['rvol'] > 2 and chg > 1:
        return 'חצתה ממוצע 20 בנפח חזק'
    if chg > 2:
        return 'מהלך עלייה ראשון — קפיצה היום'
    if s['rsi'] in ('Below 30','New Below 30'):
        return 'יוצאת ממכירת יתר — מעל ממוצע 20'
    if s['rvol'] > 1.5:
        return 'מעל ממוצע 20 בנפח מצטבר'
    return 'תחילת התאוששות — מעל ממוצע 20 בלבד'

def early_bounce_score(s):
    sc = 0
    if s['rvol'] > 1.5: sc += 30
    if s['chg'] is not None and s['chg'] > 0: sc += 25
    if s['rsi'] in ('Below 30','New Below 30','Below 50','New Below 50'): sc += 20
    # Closer to bottom = higher rebound potential (less negative w52)
    if s['w52'] is not None: sc += max(0, (s['w52'] + 50) / 2)
    return sc

strong = sorted(stocks, key=momentum, reverse=True)[:10]

# ─── Setup screener — mirror of renderSetupScreener() in index.html ─
# Filter: RSI in {oversold, weak} AND MA score >= 1 AND RVOL > 1.2.
# Ranked by a momentum-score that blends MA position, RSI level,
# proximity to 52W high, RVOL, and today's %change.
#
# This is NOT the old "buy_picks" (rebound + early-bounce mix). It's
# the dashboard's own "Setup אידיאלי" filter, ported verbatim. The
# wording "מועמדות לריבאונד עם נפח" comes straight from the dashboard.
RSI_APPROX = {
    'New Above 20': 21, 'Below 30': 25, 'New Below 30': 28, 'New Above 30': 33,
    'New Below 50': 47, 'Below 50': 42, 'New Above 50': 53, 'Above 50': 62,
    'New Below 70': 68, 'New Above 70': 72, 'Above 70': 75, 'Above 80': 83,
}
RSI_GROUPS = {
    'oversold':   {'Below 30', 'New Below 30', 'New Above 20'},
    'weak':       {'Below 50', 'New Below 50', 'New Above 30'},
    'strong':     {'Above 50', 'New Above 50'},
    'overbought': {'Above 70', 'Above 80', 'New Above 70', 'New Below 70'},
}

def rsi_group(rank):
    for g, ranks in RSI_GROUPS.items():
        if rank in ranks:
            return g
    return 'strong'

def momentum_score(s):
    """Mirror of getMomentumScore() in index.html. Returns 0-100."""
    ma_comp   = (s['ma_score'] / 4) * 30
    rsi_val   = RSI_APPROX.get(s.get('rsi') or '', 50)
    rsi_comp  = max(0, min(25, (rsi_val - 20) / 65 * 25))
    w52       = s.get('w52') or 0
    w52_comp  = max(0, min(20, (100 + w52) / 100 * 20))
    rvol_comp = min(10, (s.get('rvol') or 0) / 2 * 10)
    chg       = s.get('chg') or 0
    chg_comp  = max(0, min(15, (chg + 5) / 10 * 15))
    return round(ma_comp + rsi_comp + w52_comp + rvol_comp + chg_comp)

setup_picks = [
    s for s in stocks
    if rsi_group(s.get('rsi') or '') in ('oversold', 'weak')
       and s['ma_score'] >= 1
       and (s.get('rvol') or 0) > 1.2
]
for s in setup_picks:
    s['_momentum'] = momentum_score(s)
setup_picks.sort(key=lambda s: s['_momentum'], reverse=True)
setup_picks = setup_picks[:10]

# Unified "מומלצות לקנייה" — rebound (oversold + volume + MA support) and
# early-bounce (above MA20, below long-term MAs) merged. Rebound is the stronger
# setup, so we boost its score before ranking.
def buy_score(s):
    if is_rebound(s):
        return rebound_score(s) + 20
    return early_bounce_score(s)

def buy_kind(s):
    return 'rebound' if is_rebound(s) else 'early'

def buy_meaning(s):
    return rebound_meaning(s) if is_rebound(s) else early_bounce_meaning(s)

buy_candidates = [s for s in stocks if is_rebound(s) or is_early_bounce(s)]
buy_picks = sorted(buy_candidates, key=buy_score, reverse=True)[:5]

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
#  Daily quote — rotates by date, supports manual override
#  Override file: data/today_quote.txt (if non-empty, used instead of rotation)
# ═══════════════════════════════════════════════════
def get_daily_quote():
    # 1. Manual override file
    try:
        with open('data/today_quote.txt', encoding='utf-8') as f:
            override = f.read().strip()
        if override:
            return override
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f'Override read error: {e}')

    # 2. Curated rotating list
    try:
        with open('data/quotes.json', encoding='utf-8') as f:
            quotes = json.load(f)
    except Exception as e:
        print(f'Quotes load error: {e}')
        return ''
    if not quotes:
        return ''

    # Deterministic by date — same day = same quote, different days well-distributed
    seed_str = date_label or _date.today().isoformat()
    h = int(hashlib.md5(seed_str.encode('utf-8')).hexdigest(), 16)
    return quotes[h % len(quotes)]

daily_quote = get_daily_quote()
if _date.today() == _date(2026, 5, 16):
    daily_quote = 'ברוך הבא לקבוצה שלומי רואה החשבון העיראקי שלנו<br><br>' + daily_quote
print(f'Daily quote: {daily_quote[:80]}...')

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
    """kind: 'strong' | 'buy' | 'weak' — determines meaning + color"""
    if kind == 'strong':
        meaning = strong_meaning(s); meaning_color = '#2f855a'
    elif kind == 'buy':
        meaning = buy_meaning(s); meaning_color = '#b7791f'
    else:
        meaning = weak_meaning(s); meaning_color = '#c53030'
    sec_code = SECTOR_MAP.get(s['sym'], '')
    sec_he = SECTOR_HE.get(sec_code, '')
    sec_chip = (f'<span style="display:inline-block;font-size:10px;color:#718096;background:#edf2f7;padding:2px 7px;border-radius:10px;margin-right:6px;font-weight:500;">{sec_he}</span>'
                if sec_he else '')
    # TradingView chart link — symbol page opens the chart
    tv_url = f'https://www.tradingview.com/chart/?symbol={s["sym"]}'
    sym_link = f'<a href="{tv_url}" target="_blank" style="color:#2b6cb0;text-decoration:none;font-weight:700;border-bottom:1px dotted #cbd5e0;">{s["sym"]}</a>'
    return (f'<tr>'
            f'<td align="right" dir="ltr" style="padding:8px 10px;width:70px;text-align:right;font-size:13px;vertical-align:middle;">{sym_link}</td>'
            f'<td align="right" style="padding:8px 10px;color:{meaning_color};font-size:13px;font-weight:500;text-align:right;vertical-align:middle;">{sec_chip}— {meaning}</td>'
            f'</tr>')

# Build each section
CARD = 'background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,0.04);margin-bottom:12px;direction:rtl;'

# ─── Block 3 — מצב השוק (label + score, like dashboard's top strip) ─
s_state_html = f"""
<div dir="rtl" style="{CARD}padding:18px 22px;border-top:3px solid {accent};text-align:right;">
  <div style="font-size:11px;color:#718096;letter-spacing:0.1em;text-transform:uppercase;font-weight:600;margin-bottom:6px;text-align:right;">מצב השוק</div>
  <div dir="rtl" style="text-align:right;">
    <span style="font-size:24px;font-weight:700;color:{accent};line-height:1;">{state_label}</span>
    <span style="font-size:18px;color:#a0aec0;margin:0 8px;line-height:1;">·</span>
    <span style="font-size:24px;font-weight:700;color:{accent};font-family:monospace;line-height:1;">{c_score if c_score is not None else '—'}</span>
    <span style="font-size:12px;color:#718096;margin-right:6px;">/ 100</span>
  </div>
</div>
"""

# ─── Block 4 — סיכום היום (5 sub-blocks: ראלי חזק / היום / השבוע /
#                                          הרקע / לעקוב / בעבר) ─────
watch_for_str = ' · '.join(watch_for_now) if watch_for_now else ''
sub_block_style = ('font-size:13px;color:#4a5568;line-height:1.65;'
                   'border-top:1px solid #edf2f7;padding-top:10px;'
                   'margin-top:10px;text-align:right;direction:rtl;')
sub_label_style = 'color:#718096;font-weight:700;margin-left:6px;'

# Headline label gets a color matching the rationale's state.
HEADLINE_COLORS = {
    'ראלי חזק':           '#10b981',
    'מגמה יציבה':         '#10b981',
    'שיפור מתהווה':       '#14b8a6',
    'חולשה מתהווה':       '#f59e0b',
    'התייצבות שברירית':  '#f59e0b',
    'התייצבות':           '#64748b',
    'מצב מעורב':          '#f59e0b',
    'אזהרה מסלימה':      '#ef4444',
    'מגמה תחת לחץ':       '#ef4444',
}
headline_color = HEADLINE_COLORS.get(meta_label_now, accent)
historical_summary_str = historical_patterns_str or ''

s_summary_html = f"""
<div dir="rtl" style="{CARD}padding:20px 22px;text-align:right;">
  <div style="font-size:11px;color:#718096;letter-spacing:0.1em;text-transform:uppercase;font-weight:600;margin-bottom:10px;text-align:right;">סיכום היום</div>
  <div dir="rtl" style="text-align:right;direction:rtl;">
    <div style="font-size:18px;font-weight:700;color:{headline_color};line-height:1.2;margin-bottom:4px;text-align:right;">{meta_label_now}</div>
    <div style="font-size:12px;color:#718096;margin-bottom:8px;text-align:right;">·</div>
    <div style="font-size:13px;color:#4a5568;line-height:1.6;text-align:right;">{rationale_now}</div>
  </div>
  <div style="{sub_block_style}"><span style="{sub_label_style}">היום:</span>{today_line_now}</div>
  <div style="{sub_block_style}"><span style="{sub_label_style}">השבוע:</span>{week_line_now}</div>
  <div style="{sub_block_style}"><span style="{sub_label_style}">הרקע:</span>{background_line_now}</div>
  {('<div style="' + sub_block_style + '"><span style="' + sub_label_style + '">לעקוב:</span>' + watch_for_str + '</div>') if watch_for_str else ''}
  {('<div style="' + sub_block_style + '"><span style="' + sub_label_style + '">בעבר:</span>' + historical_summary_str + '</div>') if historical_summary_str else ''}
</div>
"""

# ─── Block 5 — מה קרה בעבר במצב דומה (3 horizon cards + scenario) ──
def historical_block_html():
    """Build the full historical patterns block — description, 3 horizon
    cards (5/10/20 days), and 3-block scenario summary. Returns '' when
    no snapshot is available so the email still renders."""
    try:
        with open('data/forward_snapshots.json', 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception:
        return ''
    snaps = data.get('snapshots') or []
    if not snaps:
        return ''
    snap = snaps[-1]
    outcomes = snap.get('outcomes') or {}
    matches = snap.get('matches') or []
    n = len(matches)
    out20 = outcomes.get('20') or {}
    if not out20 or not out20.get('samples'):
        return ''
    # Description + tendency lines
    median20 = out20.get('median', 0)
    hit20 = out20.get('hitRate', 0)
    ms = '+' if median20 >= 0 else ''
    tendency_color = '#10b981' if median20 > 0 else '#ef4444' if median20 < 0 else '#64748b'
    anchor_date = snap.get('anchorDate', '')
    if anchor_date:
        # ISO YYYY-MM-DD → DD/MM/YYYY for the Hebrew sentence
        ap = anchor_date.split('-')
        if len(ap) == 3:
            anchor_date = f'{ap[2]}/{ap[1]}/{ap[0]}'
    desc_line = (f'{n} ימים דומים מתוך 2553 ימי מסחר ב-10 השנים האחרונות. '
                 f'נכון ל-{anchor_date}.')
    tendency_line = (f'נטייה היסטורית '
                     f'<span style="color:{tendency_color};font-weight:700;">'
                     f'{"חיובית" if median20 > 0 else "שלילית" if median20 < 0 else "ניטרלית"}</span>: '
                     f'ב-{round(hit20*100)}% מהמקרים הדומים, השוק '
                     f'{"עלה" if median20 >= 0 else "ירד"} תוך 20 ימים '
                     f'(חציון {ms}{median20:.2f}%).')
    # 3 horizon cards (5/10/20)
    def card(window_days):
        o = outcomes.get(str(window_days)) or {}
        if not o.get('samples'):
            return ''
        med = o.get('median', 0)
        q25 = o.get('q25', 0)
        q75 = o.get('q75', 0)
        hit = o.get('hitRate', 0)
        sign = '+' if med >= 0 else ''
        col = '#10b981' if med > 0 else '#ef4444' if med < 0 else '#64748b'
        return (
            f'<td align="center" style="padding:12px 6px;width:33%;vertical-align:top;text-align:center;background:#f7fafc;border-radius:6px;">'
            f'<div style="font-size:11px;color:#718096;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">{window_days} ימים</div>'
            f'<div style="font-size:22px;font-weight:700;color:{col};line-height:1;font-family:monospace;">{sign}{med:.2f}%</div>'
            f'<div style="font-size:11px;color:#4a5568;margin-top:4px;">חציון · {round(hit*100)}% חיובי</div>'
            f'<div style="font-size:10px;color:#a0aec0;margin-top:4px;font-family:monospace;">טווח: {q25:.1f}% עד {q75:.1f}%</div>'
            f'</td>'
        )
    cards_row = (
        '<td style="width:8px;"></td>'.join(filter(None,
            [card(5), card(10), card(20)]))
    )
    # Scenario summary — three blocks (endpoint envelope, intraperiod, caveat)
    out5d_full = out20  # alias for clarity
    median20 = out5d_full.get('median', 0)
    mn20 = out5d_full.get('min', 0)
    mx20 = out5d_full.get('max', 0)
    samples = out5d_full.get('samples', 0)
    # Intraperiod drawdowns aren't stored in the snapshot — would need
    # per-match daily paths. For the email we use the worst final 20d
    # return (out20.min) as a proxy. This is more conservative than the
    # true intraperiod minimum (which the dashboard computes live by
    # walking each match's path), so the email says "worst FINAL close"
    # explicitly rather than overclaiming intraperiod precision.
    worst_close = out5d_full.get('min', 0)
    block1 = (
        f'<b>סוף 20 ימים</b><br>'
        f'ב-{samples} מקרים היסטוריים דומים, התשואה ביום ה-20 נעה בין '
        f'<b>{("+" if mn20 >= 0 else "")}{mn20:.2f}%</b> ל-'
        f'<b>{("+" if mx20 >= 0 else "")}{mx20:.2f}%</b>. '
        f'חציון <b>{("+" if median20 >= 0 else "")}{median20:.2f}%</b>. '
        f'<b>{round(hit20*100)}%</b> מהמקרים נסגרו בחיובי.'
    )
    block2 = (
        f'<b>בתוך 20 הימים (נפילות זמניות)</b><br>'
        f'גם בתרחיש "בריא" יש דיפים זמניים. המקרה ההיסטורי הגרוע ביותר '
        f'בסיום 20 הימים: <b>{worst_close:+.2f}%</b>. בתוך החלון הדיף '
        f'יכול להיות עמוק יותר ועדיין להתאושש — דיף כזה בימים הקרובים '
        f'<i>לא</i> שובר את התבנית.'
    )
    block3 = (
        '<b>תנאי תקפות</b><br>'
        'הניתוח מניח שהמאקרו יישאר במשטר דומה (ריבית, גיאופוליטיקה, נזילות). '
        'אירוע חריג — הפתעת ריבית, מלחמה רחבה, משבר אשראי — מבטל את ה-baseline. '
        'ההיסטוריה אינה ביטוח, היא <b>התפלגות מותנית</b>.'
    )
    scenario_blocks_html = ''.join(
        f'<div style="background:#f7fafc;padding:10px 14px;margin-top:8px;border-radius:6px;font-size:12px;color:#4a5568;line-height:1.6;text-align:right;direction:rtl;">{b}</div>'
        for b in (block1, block2, block3))
    return f"""
<div dir="rtl" style="{CARD}padding:20px 22px;text-align:right;">
  <div style="font-size:11px;color:#718096;letter-spacing:0.1em;text-transform:uppercase;font-weight:600;margin-bottom:8px;text-align:right;">מה קרה בעבר במצב דומה</div>
  <div style="font-size:12px;color:#718096;margin-bottom:6px;text-align:right;">{desc_line}</div>
  <div style="font-size:13px;color:#2d3748;margin-bottom:14px;text-align:right;line-height:1.5;">{tendency_line}</div>
  <table dir="rtl" style="width:100%;border-collapse:separate;border-spacing:0;direction:rtl;">
    <tr>{cards_row}</tr>
  </table>
  <div style="font-size:11px;color:#718096;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;margin-top:16px;margin-bottom:6px;text-align:right;">תרחיש בסיס — מה צופה ההיסטוריה ל-20 הימים הבאים</div>
  {scenario_blocks_html}
</div>
"""

s_hist_html = historical_block_html()

# ─── Block 6 — מפת חום סקטוריאלית (now with leader/laggard/dispersion) ──
def sector_heatmap_block_html():
    if not sectors_data:
        return ''
    rows = sorted(sectors_data, key=lambda x: -x['avg_chg'])
    leader = rows[0]
    laggard = rows[-1]
    dispersion = leader['avg_chg'] - laggard['avg_chg']
    table = sector_heatmap_rows_html()
    stats_block = f"""
<table dir="rtl" style="width:100%;margin-top:10px;border-collapse:collapse;direction:rtl;font-size:12px;">
  <tr>
    <td align="right" style="padding:6px 10px;color:#718096;width:33%;text-align:right;">המוביל</td>
    <td align="right" style="padding:6px 10px;color:#065f46;font-weight:700;text-align:right;">{leader['name']} · {('+' if leader['avg_chg'] >= 0 else '')}{leader['avg_chg']:.2f}% היום</td>
  </tr>
  <tr style="background:#f7fafc;">
    <td align="right" style="padding:6px 10px;color:#718096;text-align:right;">החלש ביותר</td>
    <td align="right" style="padding:6px 10px;color:#991b1b;font-weight:700;text-align:right;">{laggard['name']} · {('+' if laggard['avg_chg'] >= 0 else '')}{laggard['avg_chg']:.2f}% היום</td>
  </tr>
  <tr>
    <td align="right" style="padding:6px 10px;color:#718096;text-align:right;">פיזור היום</td>
    <td align="right" style="padding:6px 10px;font-weight:700;color:#2d3748;text-align:right;">{dispersion:.1f}%</td>
  </tr>
</table>
"""
    return f"""
<div dir="rtl" style="{CARD}padding:20px 22px;text-align:right;">
  <div style="font-size:11px;color:#718096;letter-spacing:0.1em;text-transform:uppercase;font-weight:600;margin-bottom:6px;text-align:right;">מפת חום סקטוריאלית — היום</div>
  <div style="font-size:11px;color:#a0aec0;margin-bottom:10px;text-align:right;">11 סקטורי S&amp;P 500 · שינוי יומי ממוצע · ממוין מהחזק לחלש</div>
  <table dir="rtl" style="width:100%;border-collapse:collapse;border-radius:6px;overflow:hidden;font-size:13px;direction:rtl;">
    {table}
  </table>
  {stats_block}
</div>
"""

s_heatmap_html = sector_heatmap_block_html()

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

strong_rows = ''.join(stock_row(s, 'strong') for s in strong)

# Block 7 — 10 חזקות (buy picks removed by user 2026-05-25)
s_strong_html = f"""
<div dir="rtl" style="{CARD}padding:20px 22px;text-align:right;">
  <div style="font-size:11px;color:#718096;letter-spacing:0.1em;text-transform:uppercase;font-weight:600;margin-bottom:12px;text-align:right;">10 מניות חזקות</div>
  <table dir="rtl" style="width:100%;border-collapse:collapse;direction:rtl;">
    {strong_rows}
  </table>
</div>
"""

# Block 8 — Setup אידיאלי (oversold/weak with volume + MA support)
def setup_row(s):
    """One row per setup pick — symbol + sector + 3 key metrics (RSI / MA / RVOL)."""
    sec_code = SECTOR_MAP.get(s['sym'], '')
    sec_he = SECTOR_HE.get(sec_code, '')
    sec_chip = (f'<span style="display:inline-block;font-size:10px;color:#718096;background:#edf2f7;padding:2px 7px;border-radius:10px;margin-right:6px;font-weight:500;">{sec_he}</span>'
                if sec_he else '')
    tv_url = f'https://www.tradingview.com/chart/?symbol={s["sym"]}'
    sym_link = f'<a href="{tv_url}" target="_blank" style="color:#2b6cb0;text-decoration:none;font-weight:700;border-bottom:1px dotted #cbd5e0;">{s["sym"]}</a>'
    rsi_lbl = s.get('rsi') or '—'
    ma_str  = f'{s["ma_score"]}/4'
    rvol_v  = s.get('rvol') or 0
    rvol_str = f'×{rvol_v:.1f}' if rvol_v else '—'
    mom = s.get('_momentum', 0)
    return (
        f'<tr>'
        f'<td align="right" dir="ltr" style="padding:8px 10px;width:60px;text-align:right;font-size:13px;vertical-align:middle;">{sym_link}</td>'
        f'<td align="right" style="padding:8px 10px;font-size:11px;color:#4a5568;text-align:right;vertical-align:middle;">{sec_chip}</td>'
        f'<td align="right" style="padding:8px 6px;font-size:11px;color:#c05621;text-align:right;vertical-align:middle;white-space:nowrap;">{rsi_lbl}</td>'
        f'<td align="right" style="padding:8px 6px;font-size:11px;color:#4a5568;text-align:right;vertical-align:middle;white-space:nowrap;">MA {ma_str}</td>'
        f'<td align="right" style="padding:8px 6px;font-size:11px;color:#2f855a;font-weight:600;text-align:right;vertical-align:middle;white-space:nowrap;">RVOL {rvol_str}</td>'
        f'<td align="left" style="padding:8px 10px;font-size:12px;font-weight:700;color:#1a202c;font-family:monospace;text-align:left;vertical-align:middle;width:40px;">{mom}</td>'
        f'</tr>'
    )

if setup_picks:
    setup_rows = ''.join(setup_row(s) for s in setup_picks)
    s_setup_html = f"""
<div dir="rtl" style="{CARD}padding:20px 22px;text-align:right;">
  <div style="font-size:11px;color:#718096;letter-spacing:0.1em;text-transform:uppercase;font-weight:600;margin-bottom:4px;text-align:right;">Setup אידיאלי — מועמדות לריבאונד עם נפח</div>
  <div style="font-size:11px;color:#a0aec0;margin-bottom:10px;text-align:right;">RSI חלש/oversold + MA Score ≥ 1 + RVOL &gt; 1.2 · ממוין לפי ציון מתנע</div>
  <table dir="rtl" style="width:100%;border-collapse:collapse;direction:rtl;">
    {setup_rows}
  </table>
</div>
"""
else:
    s_setup_html = f"""
<div dir="rtl" style="{CARD}padding:20px 22px;text-align:right;">
  <div style="font-size:11px;color:#718096;letter-spacing:0.1em;text-transform:uppercase;font-weight:600;margin-bottom:4px;text-align:right;">Setup אידיאלי — מועמדות לריבאונד עם נפח</div>
  <div style="font-size:12px;color:#a0aec0;text-align:right;font-style:italic;">אין מניות העומדות בקריטריונים כרגע (RSI חלש + MA ≥ 1 + RVOL &gt; 1.2).</div>
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

  <!-- Daily quote — red bold, RTL (rotates by date, override via data/today_quote.txt) -->
  <div dir="rtl" style="padding:14px 20px;margin-bottom:12px;background:#fef2f2;border-radius:8px;border-right:4px solid #dc2626;text-align:right;direction:rtl;">
    <p style="margin:0;color:#dc2626;font-size:13px;font-weight:700;line-height:1.55;text-align:right;direction:rtl;">
      {daily_quote}
    </p>
  </div>

  {s_state_html}
  {s_summary_html}
  {s_hist_html}
  {s_heatmap_html}
  {s_strong_html}
  {s_setup_html}

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
        {"email": "anavot70@gmail.com"},
        {"email": "shlomo@nimrodi.co.il"}
    ]
    subject_prefix = "📊 "

payload = json.dumps({
    "sender": {"name": "S&P Dashboard", "email": "nditzik@gmail.com"},
    "to": recipients,
    "subject": f"{subject_prefix}S&P 500 {date_label}",
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
