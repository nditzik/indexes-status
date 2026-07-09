"""
Daily Market Briefing Email
===========================
Structured 6-section brief, readable in under 60 seconds.
Replicates the dashboard's scoring logic (MCC, Technical, Options Flow)
and renders as a compact HTML email sent via Brevo on every CSV push.
"""

import csv, json, os, urllib.request, urllib.error, glob, io, hashlib, re
from datetime import date as _date

# ═══════════════════════════════════════════════════
#  File-date helpers — see README §audit-fix-1
#
#  Filenames are MM-DD-YYYY. Lex-sorting them is wrong across year
#  boundaries (01-01-2026 sorts before 12-31-2025 alphabetically). Always
#  sort by the parsed ISO date so "latest" means the most recent trading
#  day, not the alphabetical tail.
# ═══════════════════════════════════════════════════
_WATCHLIST_DATE_RE = re.compile(r'watchlist-sp-500-intraday-(\d{2})-(\d{2})-(\d{4})\.csv$')
_FLOW_DATE_RE      = re.compile(r'spx-options-flow-(\d{2})-(\d{2})-(\d{4})\.csv$')

def _iso_key(path, pattern=None):
    if pattern is None:
        pattern = _WATCHLIST_DATE_RE if 'watchlist' in path else _FLOW_DATE_RE
    m = pattern.search(path)
    if not m: return ''
    mm, dd, yyyy = m.groups()
    return f'{yyyy}-{mm}-{dd}'

def sorted_by_date(paths, pattern):
    return sorted(paths, key=lambda p: _iso_key(p, pattern))

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
vix_chg_pct = num(vix_row.get('%Change')) if vix_row else None
dxy = num(dxy_row.get('Latest')) if dxy_row else None
tnx = num(tnx_row.get('Latest')) if tnx_row else None


def _load_vix_term_ratio():
    """VIX / VIX3M term-structure ratio from the server-fetched live
    ticker (phase 2.3). >=1 = backwardation (acute near-term stress).
    Feeds the volatility light — phase 3.2."""
    try:
        with open('data/live_ticker.json', encoding='utf-8') as f:
            return json.load(f).get('vixTermRatio')
    except Exception:
        return None


vix_term_ratio = _load_vix_term_ratio()

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
            f'{round(hit*n)} מתוך {n} חיוביים. מותנה בהמשך משטר יציב.'
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
hist_files = sorted_by_date(glob.glob('data/watchlist-sp-500-intraday-*.csv'), _WATCHLIST_DATE_RE)

# ── Sectoral rotation (review fix 2 / Rotation v2) ───────────────────
# Ticker → sector-code map, loaded once. Lets parse_history_day roll up
# a per-sector average daily %change for every historical session, which
# feeds real relative-strength-vs-$SPX (compute_sector_rs below). The old
# rotation light used the EQ500-vs-SPX spread — that is a second *breadth*
# measure, not rotation. This is true sector leadership.
def _load_sector_map():
    try:
        sm = json.load(open('data/sectors.json', encoding='utf-8'))
        return sm.get('tickers') or {}
    except Exception:
        return {}
SECTOR_MAP = _load_sector_map()

def _load_sector_names():
    """Sector-code → Hebrew name (for the conclusion engine's prose)."""
    try:
        sm = json.load(open('data/sectors.json', encoding='utf-8'))
        return sm.get('codes') or {}
    except Exception:
        return {}
SECTOR_NAMES = _load_sector_names()

# Cyclical (risk-on) vs defensive (risk-off) sector codes. Rotation is
# "healthy" (green) when cyclicals lead, "risk-off" (red) when the money
# hides in defensives. Codes per data/sectors.json.
CYCLICAL_SECTORS  = {'IT', 'FIN', 'CD', 'ENE', 'IND'}
DEFENSIVE_SECTORS = {'UTL', 'CS', 'HC'}

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
    sector_chgs = {}   # sector-code → [daily %change] (rotation v2)
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
            sec = SECTOR_MAP.get(sym)
            if sec:
                sector_chgs.setdefault(sec, []).append(chg)
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
        'sector_chg':  {s: sum(v) / len(v) for s, v in sector_chgs.items()},
    }

history_rich = [d for d in (parse_history_day(hf) for hf in hist_files[-365:]) if d]

# ── Cash-index daily-change correction (mirror of overview-prod.js) ──
# Barchart's $SPX %Change cell intermittently arrives as 0.00% when the
# export predates the official index settle, while the price is correct.
# Derive the daily change from price-vs-previous-close whenever the field
# is missing or ~0; verified-good days keep Barchart's exact value. This
# keeps the email, the dashboard, and the narrative all showing the real
# move instead of a stale zero.
_INDEX_CHG_EPS = 0.005
for _i in range(1, len(history_rich)):
    _cur, _prev = history_rich[_i], history_rich[_i - 1]
    _c, _p = _cur.get('spx_chg_pct'), _prev.get('spx_price')
    if (_cur.get('spx_price') is not None and _p not in (None, 0)
            and (_c is None or abs(_c) < _INDEX_CHG_EPS)):
        _cur['spx_chg_pct'] = (_cur['spx_price'] / _p - 1) * 100
# Top-level `spx` mirrors data.txt = latest day; fix from the prior day.
if spx and spx.get('chgPct') is not None and len(history_rich) >= 2:
    if abs(spx['chgPct']) < _INDEX_CHG_EPS:
        _pp = history_rich[-2].get('spx_price')
        if spx.get('price') is not None and _pp not in (None, 0):
            spx['chgPct'] = (spx['price'] / _pp - 1) * 100
elif spx and spx.get('chgPct') is None and len(history_rich) >= 2:
    _pp = history_rich[-2].get('spx_price')
    if spx.get('price') is not None and _pp not in (None, 0):
        spx['chgPct'] = (spx['price'] / _pp - 1) * 100

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
sell_days_3      = sum(1 for d in history_rich[-3:] if is_selling_day(d))
weekly_change    = sum(history[-5:]) if len(history) >= 3 else None

# ═══════════════════════════════════════════════════
#  Risk-Off detection — surfaces when the structural scores will
#  under-react to a real risk event. Same triggers as the dashboard.
# ═══════════════════════════════════════════════════
def detect_risk_off():
    reasons = []
    spx_chg = spx['chgPct'] if spx else None
    if spx_chg is not None and spx_chg <= -1.5:
        reasons.append(f'המדד ירד {abs(spx_chg):.2f}% ביום אחד — ירידה חדה')
    if vix_chg_pct is not None and vix_chg_pct >= 25:
        reasons.append(f'מדד הפחד קפץ {vix_chg_pct:.0f}% ביום אחד')
    if dist_days >= 4:
        reasons.append(f'{dist_days} ימי מכירה רחבה בחודש האחרון (הסף: 4) — לחץ מוסדי מצטבר')
    if sell_days_3 >= 2:
        reasons.append(f'{sell_days_3} ימי מכירה בתוך 3 ימי המסחר האחרונים — קיבוץ הדוק')
    return reasons

risk_off_reasons = detect_risk_off()

# Acute = same-day event (crash / VIX spike). Background-only warnings
# (accumulated selling days) must not flip the headline to "יום סיכון"
# on a green close — mirror of metrics.riskOff.acute in the dashboard.
risk_off_acute = (
    (spx and spx['chgPct'] is not None and spx['chgPct'] <= -1.5)
    or (vix_chg_pct is not None and vix_chg_pct >= 25)
)

# The actual selling days (date + SPX move) — listed inside the email
# banner so the count is verifiable at a glance.
risk_off_selling_days = [
    (d['date'], d.get('spx_chg_pct'))
    for d in last25_rich if is_selling_day(d)
]


# ═══════════════════════════════════════════════════
#  Selling-pressure card (redesign) — three fixed lines, built in
#  Python so the dashboard and the email render ONE state. No scoring
#  formula changes here: this is presentation of existing signals
#  (combined score, distribution days, 3-day cluster, acute event), so
#  FORMULA_VERSION is intentionally NOT bumped.
# ═══════════════════════════════════════════════════
def _acute_reason():
    """Same-day trigger text for an acute (risk) day, or '' if none."""
    spx_chg = spx['chgPct'] if spx else None
    if spx_chg is not None and spx_chg <= -1.5:
        return f'המדד ירד {abs(spx_chg):.2f}% ביום אחד'
    if vix_chg_pct is not None and vix_chg_pct >= 25:
        return f'מדד הפחד קפץ {vix_chg_pct:.0f}% ביום אחד'
    return ''


def build_pressure_state_line(combined, acute):
    """Line 1 — state: icon-less one-sentence context. The score band
    (≥70 strong / 55-69 stable / <55 weak) frames the accumulated
    pressure against the broad trend."""
    if acute:
        ar = _acute_reason()
        return 'יום סיכון בשוק' + (f' — {ar}' if ar else '')
    if combined is None:
        band = 'לא ידוע'
    elif combined >= 70:
        band = 'חזק'
    elif combined >= 55:
        band = 'יציב'
    else:
        band = 'חלש'
    suffix = f' ({combined})' if combined is not None else ''
    return f'לחץ מכירות מוסדי מצטבר — על רקע שוק {band}{suffix}'


def build_pressure_evidence_line(distribution_days, sell_days_2w):
    """Line 2 — evidence (text only; the dashboard adds the 25-dot bar).
    'שבועיים' = the last 10 trading sessions."""
    return (f'{distribution_days} ימי מכירה ב-25 הימים · '
            f'{sell_days_2w} מהם בשבועיים האחרונים')


def build_pressure_action(combined, distribution_days, sell_days_recent_3, acute):
    """Line 3 — action, from the state matrix (priority order). Every
    line carries its own EXIT condition — when the warning lifts."""
    if acute:
        ar = _acute_reason()
        return ('לא קונים היום' + (f' — {ar}' if ar else '')
                + ' · חזרה לפעילות רק אחרי יום מסחר יציב')
    if sell_days_recent_3 is not None and sell_days_recent_3 >= 2:
        return ('עצירת קניות זמנית — גל מכירות בעיצומו · '
                'חזרה לשגרה אחרי 3 ימים נקיים')
    if combined is None:
        return 'להמתין — אין מספיק נתונים להכרעה'
    if combined >= 70:
        return ('להחזיק קיימות · כניסות חדשות במנות קטנות בלבד · '
                'בלי מינוף עד שהלחץ יירד מתחת ל-4 ימים')
    if combined >= 55:
        return ('לא להוסיף חשיפה חדשה · להדק סטופים על החלשות בתיק · '
                'המתנה לירידת הלחץ מתחת ל-4 ימים')
    return 'הגנה — לקצץ חשיפה בהדרגה · עדיפות למזומן עד שינוי משטר'


def sell_days_map(n=25):
    """The last n sessions as {date, chgPct, isSell} — chronological.
    Powers the 25-dot visual bar; the full date list lives only in the
    dot tooltips now, not in the card text."""
    out = []
    for d in history_rich[-n:]:
        chg = d.get('spx_chg_pct')
        out.append({
            'date': d.get('date'),
            'chgPct': round(chg, 2) if chg is not None else None,
            'isSell': is_selling_day(d),
        })
    return out


def fmt_market_chg(v):
    """Honest formatting for the index's daily change. Barchart sometimes
    leaves $SPX %Change blank or derives a hairline zero — never render
    that as a green '+0.00%'."""
    if v is None:
        return 'טרם התעדכן'
    if abs(v) < 0.005:
        return 'ללא שינוי'
    return f'{v:+.2f}%'

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
    # Day %Change weight bumped from 5 → 15 (mirror of overview-prod.js)
    if spx['chgPct'] is not None:
        c = spx['chgPct']
        parts.append(15 if c > 1.0 else 12 if c > 0.5 else 9 if c >= -0.5 else 5 if c >= -1.0 else 2 if c >= -1.5 else 0)
        max_ += 15
    # VIX-delta — forward-looking risk component (10 pts)
    if vix_chg_pct is not None:
        v = vix_chg_pct
        parts.append(10 if v <= -10 else 8 if v <= 0 else 5 if v <= 10 else 2 if v <= 25 else 0)
        max_ += 10
    if max_ == 0: return None
    return clamp(round(sum(parts) / max_ * 100))

t_score = tech_score()

# ═══════════════════════════════════════════════════
#  Score 2b · Breadth — mirror of dashboard scoreBreadth
#  Replaces market_score in the Combined weighting so the email's
#  Combined number matches the dashboard's (0.40·T + 0.35·F + 0.25·B).
# ═══════════════════════════════════════════════════
def breadth_score():
    parts, max_ = [], 0
    # MA200 component (25)
    parts.append(25 if p200 >= 65 else 18 if p200 >= 50 else 10 if p200 >= 40 else 3)
    max_ += 25
    # Health (15)
    parts.append(15 if health >= 70 else 10 if health >= 55 else 5 if health >= 40 else 1)
    max_ += 15
    # NH/NL ratio (10)
    if nh_nl == 99 or nh_nl >= 1.5: parts.append(10)
    elif nh_nl >= 1.0: parts.append(7)
    elif nh_nl >= 0.7: parts.append(3)
    else: parts.append(0)
    max_ += 10
    # Avg change (5)
    if avg_change is not None:
        parts.append(5 if avg_change > 0.5 else 3 if avg_change >= -0.5 else 0)
        max_ += 5
    # RSI ≥50 share (10)
    if total:
        rsi50pct = rsi_above50 / total * 100
        parts.append(10 if rsi50pct >= 65 else 7 if rsi50pct >= 50 else 4 if rsi50pct >= 40 else 1)
        max_ += 10
    if max_ == 0: return None
    return clamp(round(sum(parts) / max_ * 100))

b_score = breadth_score()

# ═══════════════════════════════════════════════════
#  Score 3 · Options Flow — mirror of dashboard formula
#
#  Dashboard's directional Flow Score (overview-prod.js scoreFromMetrics):
#    score = 50
#          + (callShare       - 50) * 1.0    # directional premium share
#          + (callAskPmDir    - 50) * 0.5    # call Ask aggression
#          - (putAskPmDir     - 50) * 0.5    # put Ask aggression (inverted)
#  where:
#    callShare    = callDir$ / (callDir$ + putDir$)
#    callDir$     = callAskP + callBidP            (Mid excluded — block/dealer)
#    putDir$      = putAskP  + putBidP
#    callAskPmDir = callAskP / (callAskP + callBidP) * 100   # directional only
#    putAskPmDir  = putAskP  / (putAskP  + putBidP)  * 100   # directional only
#
#  FORMULA v4 (2026-07-04): the Ask-aggression denominators now EXCLUDE
#  Mid, matching overview-prod.js. Previously Python divided by total
#  call/put premium (Mid included), which on high-Mid days (e.g. 68.5%
#  Mid on 07-02) diluted the aggressive-buying signal to near-zero and
#  produced a falsely-balanced score (54 vs the correct 40). Mid is
#  dealer/block flow — non-directional — so it must not be in a measure
#  of directional aggression. This aligns the official score with the JS
#  dashboard panels.
# ═══════════════════════════════════════════════════
flow_files = sorted_by_date(glob.glob('data/spx-options-flow-*.csv'), _FLOW_DATE_RE)
flow = None
if flow_files:
    try:
        rows = load_csv(flow_files[-1])
        call_tr = put_tr = 0
        callAskP = callBidP = callMidP = 0.0
        putAskP  = putBidP  = putMidP  = 0.0
        for r in rows:
            t = (r.get('Type','') or '').strip().lower()
            side = (r.get('Side','') or '').strip().lower()
            pr = num(r.get('Premium')) or 0
            if t == 'call':
                call_tr += 1
                if   side == 'ask': callAskP += pr
                elif side == 'bid': callBidP += pr
                else:               callMidP += pr
            elif t == 'put':
                put_tr += 1
                if   side == 'ask': putAskP += pr
                elif side == 'bid': putBidP += pr
                else:               putMidP += pr
        call_p = callAskP + callBidP + callMidP
        put_p  = putAskP  + putBidP  + putMidP
        total_tr = call_tr + put_tr
        total_p  = call_p + put_p
        callDirP = callAskP + callBidP
        putDirP  = putAskP  + putBidP

        if total_tr > 0 and (callDirP + putDirP) > 0:
            callShare    = callDirP / (callDirP + putDirP) * 100
            # v4: directional-only denominators (Mid excluded) — see header.
            callAskPmDir = callAskP / callDirP * 100 if callDirP > 0 else 50
            putAskPmDir  = putAskP  / putDirP  * 100 if putDirP  > 0 else 50
            score = 50 + (callShare - 50) * 1.0 + (callAskPmDir - 50) * 0.5 - (putAskPmDir - 50) * 0.5
            score = clamp(round(score))

            # Map score → 5-level label (mirror of classifyByScore in JS)
            if   score >= 80: label, tone = 'שורי חזק',   'pos'
            elif score >= 60: label, tone = 'שורי מתון',  'pos'
            elif score >= 40: label, tone = 'מאוזן',      'warn'
            elif score >= 20: label, tone = 'באריש מתון', 'warn'
            else:             label, tone = 'באריש חזק',  'neg'

            # Flow confidence tier — derived from Mid dominance.
            # See README §audit-fix-6.
            midPct = (callMidP + putMidP) / total_p * 100 if total_p else 0
            if   midPct >= 80: confidence_tier, confidence_note = 'low',     f'⛔ {midPct:.0f}% Mid — ביטחון נמוך בציון'
            elif midPct >= 70: confidence_tier, confidence_note = 'limited', f'⚠ {midPct:.0f}% Mid — ביטחון מוגבל'
            elif midPct >= 50: confidence_tier, confidence_note = 'mid',     f'⚠ {midPct:.0f}% Mid (בלוקים/דילרים)'
            else:              confidence_tier, confidence_note = 'high',    ''

            # Legacy ratios — kept for narrative compatibility but now
            # computed from DIRECTIONAL premium so they line up with the
            # dashboard's interpretation (Mid blocks excluded).
            pc_tr  = put_tr / call_tr if call_tr > 0 else None
            pc_p   = putDirP / callDirP if callDirP > 0 else None
            net_p  = callDirP - putDirP
            flow = {
                'score': score,
                'label': label,
                'tone':  tone,
                'callShare': round(callShare, 1),
                'callAskPmDir': round(callAskPmDir, 1),
                'putAskPmDir':  round(putAskPmDir, 1),
                'midPct': round(midPct, 1),
                # Directional share = Ask+Bid premium / total (Mid excluded).
                # Drives the dynamic Flow weight in combined() — phase 3.1.
                'directionalShare': round((callDirP + putDirP) / total_p, 4) if total_p else None,
                'confidence_tier': confidence_tier,
                'confidence_note': confidence_note,
                'pc_tr': pc_tr, 'pc_p': pc_p, 'net_p': net_p,
                'call_p_pct': call_p/total_p*100 if total_p else 0,
                'put_p_pct':  put_p/total_p*100  if total_p else 0,
                'call_tr_pct': call_tr/total_tr*100,
                'put_tr_pct':  put_tr/total_tr*100,
                'call_tr': call_tr, 'put_tr': put_tr,
                # Directional notionals — surfaced in the email's flow
                # block when Mid is dominant, so the reader sees what the
                # institutional positioning actually looked like.
                'callAskP': callAskP, 'callBidP': callBidP,
                'putAskP': putAskP, 'putBidP': putBidP,
            }
    except Exception as e:
        print(f'Options flow parse error: {e}')

f_score = flow['score'] if flow else None


# ═══════════════════════════════════════════════════
#  Flow — daily direction label, monthly-smoothed read, and the
#  daily-vs-monthly comparison. DISPLAY ONLY: the official Flow score
#  (f_score, feeds Combined) is untouched, so FORMULA_VERSION is NOT
#  bumped. The options tab previously showed the SAME directional score
#  twice (top card + bottom panel); the bottom panel now shows a
#  direction label + one comparison sentence instead of a duplicate
#  number.
# ═══════════════════════════════════════════════════
def _flow_score_from_file(path):
    """The directional Flow score for one historical flow CSV — the
    exact scoreFromMetrics formula used for today (line ~694), so the
    trailing scores are on the same scale as f_score. Returns None when
    the file has no directional premium."""
    try:
        rows = load_csv(path)
    except Exception:
        return None
    callAskP = callBidP = callMidP = 0.0
    putAskP = putBidP = putMidP = 0.0
    call_tr = put_tr = 0
    for r in rows:
        t = (r.get('Type', '') or '').strip().lower()
        side = (r.get('Side', '') or '').strip().lower()
        pr = num(r.get('Premium')) or 0
        if t == 'call':
            call_tr += 1
            if side == 'ask':   callAskP += pr
            elif side == 'bid': callBidP += pr
            else:               callMidP += pr
        elif t == 'put':
            put_tr += 1
            if side == 'ask':   putAskP += pr
            elif side == 'bid': putBidP += pr
            else:               putMidP += pr
    callDirP = callAskP + callBidP
    putDirP  = putAskP + putBidP
    if (call_tr + put_tr) > 0 and (callDirP + putDirP) > 0:
        callShare    = callDirP / (callDirP + putDirP) * 100
        # v4: directional-only denominators (Mid excluded).
        callAskPmDir = callAskP / callDirP * 100 if callDirP > 0 else 50
        putAskPmDir  = putAskP  / putDirP  * 100 if putDirP  > 0 else 50
        return clamp(round(50 + (callShare - 50)
                           + (callAskPmDir - 50) * 0.5
                           - (putAskPmDir - 50) * 0.5))
    return None


# Trailing daily scores (oldest→newest, today last) over ~22 sessions.
_recent_flow_scores = [s for s in
                       (_flow_score_from_file(p) for p in flow_files[-22:])
                       if s is not None]
# Monthly-smoothed read = simple average of the trailing daily scores.
flow_smoothed = (round(sum(_recent_flow_scores) / len(_recent_flow_scores))
                 if _recent_flow_scores else None)


def _flow_streak(scores, smoothed, min_gap=5):
    """Consecutive recent sessions (incl. today) whose daily read sits on
    today's side of the monthly-smoothed read by a meaningful margin."""
    if not scores or smoothed is None:
        return 0
    diff = scores[-1] - smoothed
    if abs(diff) < min_gap:
        return 0
    sign = 1 if diff > 0 else -1
    n = 0
    for s in reversed(scores):
        d = s - smoothed
        if abs(d) >= min_gap and (1 if d > 0 else -1) == sign:
            n += 1
        else:
            break
    return n


flow_streak = _flow_streak(_recent_flow_scores, flow_smoothed)


def build_flow_direction(score, fl):
    """Daily direction label (≥55 offensive / 45-54 balanced / <55
    defensive) + a short reason from the directional P/C premium."""
    if score is None:
        return {'label': 'לא ידוע', 'reason': ''}
    if score >= 55:
        label = 'התקפי'
    elif score >= 45:
        label = 'מאוזן'
    else:
        label = 'הגנתי'
    pc = fl.get('pc_p') if fl else None
    if pc is not None:
        if pc > 0.40:
            reason = f'פרמיית Puts דומיננטית (P/C {pc:.2f})'
        elif pc < 0.30:
            reason = f'פרמיית Calls דומיננטית (P/C {pc:.2f})'
        else:
            reason = f'איזון בין Calls ל-Puts (P/C {pc:.2f})'
    else:
        reason = ''
    return {'label': label, 'reason': reason}


def build_flow_compare(score, smoothed, streak):
    """One-sentence read of today vs the monthly-smoothed flow."""
    if score is None or smoothed is None:
        return ''
    diff = score - smoothed
    if abs(diff) < 5:
        return 'היום עקבי עם המגמה החודשית'
    base = ('היום הגנתי יותר מהממוצע החודשי' if diff < 0
            else 'היום התקפי יותר מהממוצע החודשי')
    if streak >= 2:
        return f'{base} — יום {streak} ברצף'
    return base


flow_direction = build_flow_direction(f_score, flow)
flow_compare_line = build_flow_compare(f_score, flow_smoothed, flow_streak)


# ═══════════════════════════════════════════════════
#  Combined signal — mirror of dashboard combineScores
#  Weights: 40% Tech + 35% Flow + 25% Breadth (auto re-normalize)
#  m_score (market health) is kept as a separate narrative input,
#  not part of Combined any more.
# ═══════════════════════════════════════════════════
def _score_light(s):
    if s is None:
        return 'na'
    return 'pos' if s >= 60 else 'warn' if s >= 40 else 'neg'


def combined():
    # Phase 3.1 — dynamic Flow weight. When most premium sits in Mid
    # (dealers/blocks, non-directional) the Flow score is less trustworthy,
    # so scale its weight by the directional share. The freed weight flows
    # proportionally to Tech + Breadth automatically via the num/den
    # re-normalization (they keep their absolute 0.40 / 0.25 weights, so a
    # smaller den lifts their relative influence in the 0.40:0.25 ratio).
    ds = flow.get('directionalShare') if flow else None
    w_f = 0.35 * ds if ds is not None else 0.35
    w = {'t': 0.40, 'f': w_f, 'b': 0.25}
    num_, den = 0.0, 0.0
    if t_score is not None: num_ += w['t']*t_score; den += w['t']
    if f_score is not None: num_ += w['f']*f_score; den += w['f']
    if b_score is not None: num_ += w['b']*b_score; den += w['b']
    if den == 0:
        return None, 0
    raw = num_ / den
    # Phase 3.3 — contradiction penalty. Trend green while Breadth red
    # (or vice versa) = a narrow rally the blended score alone hides.
    # Dock a flat 10 points and flag it in the verdict.
    penalty = 10 if {_score_light(t_score), _score_light(b_score)} == {'pos', 'neg'} else 0
    return clamp(round(raw - penalty)), penalty


c_score, contradiction_penalty = combined()

# Effective Flow weight — surfaced in daily_state so the dashboard's flow
# card can show "משקל Flow היום: X% (Y% מהפרמיה ב-Mid)".
_ds = flow.get('directionalShare') if flow else None
flow_weight = {
    'effective': round(0.35 * _ds, 4) if _ds is not None else 0.35,
    'directionalShare': _ds,
    'midShare': round(flow['midPct'] / 100, 4) if flow else None,
}

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
       v2/narrative.js buildHeadline — keep the two in sync."""
    regime_class = 'pos' if phase_id in ('confirmed_uptrend','uptrend_pressure','thrust') else (
                    'neg' if phase_id in ('correction','capitulation','distribution') else 'warn')

    # ── Risk-Off override — highest priority (mirror of narrative.js) ──
    # On a risk event day the headline must never read bullish ("ראלי
    # חזק on a -1.6% day" bug). Gated on ACUTE only: background-only
    # warnings must not relabel a green close as "יום סיכון".
    if risk_off_reasons and risk_off_acute:
        reasons_txt = ' · '.join(risk_off_reasons)
        if regime_class == 'pos':
            return ('יום סיכון בתוך מגמה חיובית',
                    reasons_txt + ' — המבנה ארוך-הטווח עדיין חיובי, אבל היום עצמו מסוכן')
        return ('יום סיכון', reasons_txt)

    s5 = cumulative_spread(history_rich_arg, 5) or 0
    bd = metrics.get('breadth5dDelta') or 0
    recent_score = s5 * 0.5 + bd * 0.05

    # SPX 5-day direction gate — positive spread on a falling market is
    # breadth RESILIENCE, not IMPROVEMENT. recent_pos requires the index
    # itself up over the window; a 5d drop <= -2% forces recent_neg.
    spx5d = 0.0
    counted = 0
    for d in history_rich_arg[-5:]:
        c = d.get('spx_chg_pct')
        if c is None:
            continue
        spx5d += c
        counted += 1
    if counted == 0:
        spx5d = 0.0
    recent_pos = recent_score > 0.5 and spx5d > 0
    recent_neg = recent_score < -0.5 or spx5d <= -2

    if regime_class == 'pos':
        if recent_pos:
            return ('ראלי חזק',
                    f'המגמה הטכנית חיובית והרוחב מתחזק '
                    f'({recent_driver_phrase(metrics, history_rich_arg)})')
        if recent_neg:
            sp = cumulative_spread(history_rich_arg, 5)
            if spx5d <= -2:
                weak_txt = f'SPX ירד {abs(spx5d):.1f}% בחמשת הימים האחרונים'
            elif sp is not None and sp < 0:
                weak_txt = f'הרוחב נחלש ({sp:.1f}% השבוע)'
            else:
                weak_txt = 'חולשה בשבוע האחרון'
            return ('חולשה מתהווה',
                    f'המגמה הטכנית עדיין חיובית אבל {weak_txt}')
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
    'יום סיכון בתוך מגמה חיובית': '#f59e0b',
    'יום סיכון':          '#ef4444',
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

# ─── Match-quality classification ──
#
# Mirror of forward-tracking.js classifyMatchQuality. Forces honesty
# when the KNN can't find enough close neighbors instead of pretending
# a "forecast" exists.
MATCH_GOOD_THRESHOLD = 1.0
MIN_GOOD_FOR_TRUSTED = 7

def classify_match_quality(snap):
    matches = (snap or {}).get('matches') or []
    good = [m for m in matches if m.get('distance') is not None and m['distance'] <= MATCH_GOOD_THRESHOLD]
    if len(good) >= MIN_GOOD_FOR_TRUSTED:
        return {'tier': 'trusted', 'goodCount': len(good), 'goodMatches': good}
    return {'tier': 'insufficient', 'goodCount': len(good), 'goodMatches': good}


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
    # Gate: when the latest snapshot has insufficient matches, the
    # historical block's outcomes were computed from a polluted KNN
    # sample and would mislead. Show an honest "model can't help"
    # block instead of the horizon cards.
    quality = classify_match_quality(snap)
    anchor_date_iso = snap.get('anchorDate', '')
    anchor_date = anchor_date_iso
    if anchor_date_iso:
        ap = anchor_date_iso.split('-')
        if len(ap) == 3:
            anchor_date = f'{ap[2]}/{ap[1]}/{ap[0]}'
    if quality['tier'] == 'insufficient':
        return f"""
<div dir="rtl" style="{CARD}padding:20px 22px;text-align:right;">
  <div style="font-size:11px;color:#718096;letter-spacing:0.1em;text-transform:uppercase;font-weight:600;margin-bottom:8px;text-align:right;">מה קרה בעבר במצב דומה</div>
  <div style="background:#fef2f2;color:#7f1d1d;border:1px solid #fca5a5;border-radius:8px;padding:16px;font-size:13px;line-height:1.6;text-align:right;">
    <div style="font-weight:800;font-size:14px;margin-bottom:8px;">⛔ לא מצאתי ימים דומים מספיק ב-{anchor_date}</div>
    רק <b>{quality['goodCount']} מתוך 10 התאמות</b> נמצאו במרחק ≤ {MATCH_GOOD_THRESHOLD:.1f}. המצב היום נדיר היסטורית — המודל לא יכול להציע אינדיקציה היסטורית ל-5/10/20 ימים. <b>להישען על האינדיקטורים המבניים</b> (Tech, Flow, Breadth, רוחב, VIX) ולא על אנלוגיה היסטורית.
  </div>
</div>
"""
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
    # Year spread of matches — an all-pre-2020 set reads very differently
    # from one that includes the current market structure.
    match_years = sorted({(m.get('date') or '')[:4] for m in matches if m.get('date')})
    yr_range = ''
    if match_years:
        yr_range = (f' טווח שנים: {match_years[0]}'
                    + (f'-{match_years[-1]}' if match_years[-1] != match_years[0] else '')
                    + '.')
    n20 = out20.get('samples', n)
    desc_line = (f'{n} ימים דומים מתוך 2553 ימי מסחר ב-10 השנים האחרונות.'
                 f'{yr_range} נכון ל-{anchor_date}.')
    tendency_line = (f'נטייה היסטורית '
                     f'<span style="color:{tendency_color};font-weight:700;">'
                     f'{"חיובית" if median20 > 0 else "שלילית" if median20 < 0 else "ניטרלית"}</span>: '
                     f'ב-{round(hit20*n20)} מתוך {n20} מקרים דומים, השוק '
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
        o_n = o.get('samples', 0)
        sign = '+' if med >= 0 else ''
        col = '#10b981' if med > 0 else '#ef4444' if med < 0 else '#64748b'
        return (
            f'<td align="center" style="padding:12px 6px;width:33%;vertical-align:top;text-align:center;background:#f7fafc;border-radius:6px;">'
            f'<div style="font-size:11px;color:#718096;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">{window_days} ימים</div>'
            f'<div style="font-size:22px;font-weight:700;color:{col};line-height:1;font-family:monospace;">{sign}{med:.2f}%</div>'
            f'<div style="font-size:11px;color:#4a5568;margin-top:4px;">חציון · {round(hit*o_n)} מתוך {o_n} חיוביים</div>'
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
        f'<b>{round(hit20*samples)} מתוך {samples}</b> מקרים נסגרו בחיובי.'
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

# ─── Block 5b — תבניות אחרי 5 ימים (cumulative history) ──
def add_trading_days(iso_date, n):
    """Mirror of forward-tracking.js addTradingDays. Adds n US trading
    days to iso_date, skipping weekends + a small holiday whitelist."""
    from datetime import date as _date2, timedelta
    holidays = {
        '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25',
        '2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
        '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31',
        '2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24',
    }
    y, m, d = map(int, iso_date.split('-'))
    cur = _date2(y, m, d)
    added = 0
    while added < n:
        cur = cur + timedelta(days=1)
        if cur.weekday() >= 5: continue
        if cur.isoformat() in holidays: continue
        added += 1
    return cur.isoformat()

def find_hist_idx(iso_date):
    """Index of iso_date in history_rich, or -1."""
    for i, h in enumerate(history_rich):
        if h.get('date') == iso_date:
            return i
    return -1

def fmt_iso_short(iso):
    if not iso or len(iso) < 10: return iso or '—'
    return f'{iso[8:10]}/{iso[5:7]}'

def matured_patterns_block_html():
    """Table of snapshots that have PASSED their 5-day examination window.
    For each row:
      - Capture date
      - Actual SPX 5d return + KNN 5d forecast
      - Match indicator (same direction = ✓ יש התאמה)
      - Day-20 target date + KNN 20d forecast + range + hit-rate + samples
    Bottom: how many rows matched out of total, median 20d forecast."""
    EARLY = 5
    try:
        with open('data/forward_snapshots.json', 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception:
        return ''
    snaps = data.get('snapshots') or []
    if not snaps:
        return ''
    sorted_snaps = sorted(snaps, key=lambda s: s.get('anchorDate', ''), reverse=True)
    last_idx = len(history_rich) - 1

    rows_html = []
    all_fc20 = []
    skipped_dates = []   # insufficient matches — listed once below
    total_rows = 0
    # 5d interim tracking (range containment) + Day-20 final verdict
    within5 = break5 = surprise5 = 0
    judged20 = in_range20 = 0
    for snap in sorted_snaps:
        anchor = snap.get('anchorDate', '')
        a_idx = find_hist_idx(anchor)
        if a_idx < 0:
            continue
        fwd = last_idx - a_idx
        # Only show rows where 5 trading days have already passed
        if fwd < EARLY:
            continue

        quality = classify_match_quality(snap)

        # Insufficient-quality snapshots are NOT shown as rows — they're
        # disclosed once in a thin summary line below the table.
        if quality['tier'] == 'insufficient':
            skipped_dates.append(fmt_iso_short(anchor))
            continue
        total_rows += 1

        out5  = (snap.get('outcomes') or {}).get('5')  or {}
        out20 = (snap.get('outcomes') or {}).get('20') or {}
        fc5   = out5.get('median')
        min5  = out5.get('min')
        max5  = out5.get('max')
        fc20  = out20.get('median')
        hit20 = out20.get('hitRate')
        min20 = out20.get('min')
        max20 = out20.get('max')
        samples = out20.get('samples') or len(snap.get('matches') or [])

        # Actual SPX 5d return
        a_lvl = history_rich[a_idx].get('spx_price')
        t_lvl = history_rich[a_idx + EARLY].get('spx_price') if a_idx + EARLY < len(history_rich) else None
        actual5 = None
        if a_lvl and t_lvl:
            actual5 = (t_lvl / a_lvl - 1) * 100

        def fmt_pct(v):
            if v is None: return '—'
            return f'{"+" if v >= 0 else ""}{v:.2f}%'
        def col(v):
            if v is None: return '#64748b'
            return '#10b981' if v > 0 else ('#ef4444' if v < 0 else '#64748b')

        # ── 5d INTERIM tracking — range containment, NOT direction ──
        # Mirror of forward-tracking.js: dips inside the window are
        # expected; the honest interim question is whether the 5d path
        # is within what the historical analogs actually did.
        if actual5 is not None and min5 is not None and max5 is not None:
            if actual5 < min5:
                track_html = (f'<span style="color:#ef4444;font-weight:700;">🔴 חריגה מהתבנית</span>'
                              f'<div style="font-size:10px;color:#a0aec0;margin-top:2px;">מתחת למינימום ההיסטורי ({fmt_pct(min5)})</div>')
                break5 += 1
            elif actual5 > max5:
                track_html = (f'<span style="color:#2563eb;font-weight:700;">🔵 הפתעה חיובית</span>'
                              f'<div style="font-size:10px;color:#a0aec0;margin-top:2px;">מעל למקסימום ההיסטורי ({fmt_pct(max5)})</div>')
                surprise5 += 1
            else:
                track_html = (f'<span style="color:#10b981;font-weight:700;">🟢 בתוך התרחיש</span>'
                              f'<div style="font-size:10px;color:#a0aec0;margin-top:2px;">טווח האנלוגים: {fmt_pct(min5)} עד {fmt_pct(max5)}</div>')
                within5 += 1
        else:
            track_html = '<span style="color:#a0aec0;font-style:italic;">—</span>'

        target20_iso = add_trading_days(anchor, 20) if anchor else ''

        # Dead-zone gate: hit rate 40-60% = no statistical edge.
        dead_zone = hit20 is not None and 0.4 <= hit20 <= 0.6

        if dead_zone:
            fc20_cell = '<span style="color:#a0aec0;font-style:italic;font-weight:400;">אין יתרון סטטיסטי</span>'
            hit_str = (f'<span style="color:#a0aec0;">{round(hit20 * samples)} מתוך {samples}</span>'
                       if samples else '—')
            fc20_color = '#a0aec0'
        else:
            fc20_range = (f'<div style="font-size:10px;color:#a0aec0;font-weight:400;margin-top:2px;">'
                          f'{fmt_pct(min20)} עד {fmt_pct(max20)}</div>'
                          if (min20 is not None and max20 is not None) else '')
            fc20_prices = ''
            if a_lvl and (min20 is not None) and (max20 is not None):
                low_px  = round(a_lvl * (1 + min20 / 100))
                high_px = round(a_lvl * (1 + max20 / 100))
                fc20_prices = (f'<div style="font-size:10px;color:#a0aec0;font-weight:400;margin-top:2px;">'
                               f'{low_px:,} — {high_px:,}</div>')
            fc20_cell = f'{fmt_pct(fc20)}{fc20_range}{fc20_prices}'
            hit_str = (f'{round(hit20 * samples)} מתוך {samples}'
                       if (hit20 is not None and samples) else '—')
            fc20_color = col(fc20)
        matches_str = f'{samples}/{samples}' if samples else '—'

        # ── Day-20 FINAL verdict — the model's real test ──
        if fwd >= 20:
            lvl20 = history_rich[a_idx + 20].get('spx_price') if a_idx + 20 < len(history_rich) else None
            if a_lvl and lvl20:
                actual20 = (lvl20 / a_lvl - 1) * 100
                a20_str = f'<span style="color:{col(actual20)};font-weight:700;">{fmt_pct(actual20)}</span>'
                if not dead_zone and min20 is not None and max20 is not None:
                    in_r = min20 <= actual20 <= max20
                    gap = (actual20 - fc20) if fc20 is not None else None
                    judged20 += 1
                    if in_r:
                        in_range20 += 1
                    gap_txt = f' · פער מהחציון {"+" if gap >= 0 else ""}{gap:.2f}%' if gap is not None else ''
                    verdict_cell = (f'{a20_str}<div style="font-size:10px;color:#a0aec0;margin-top:2px;">'
                                    f'{"✓ בתוך הטווח החזוי" if in_r else "✗ מחוץ לטווח החזוי"}{gap_txt}</div>')
                else:
                    verdict_cell = (f'{a20_str}<div style="font-size:10px;color:#a0aec0;font-style:italic;margin-top:2px;">'
                                    f'לא נטען יתרון — אין פסיקה</div>')
            else:
                verdict_cell = '<span style="color:#a0aec0;font-style:italic;">אין מחיר</span>'
        else:
            remaining = 20 - fwd
            verdict_cell = f'<span style="color:#f59e0b;font-weight:600;font-size:11px;">ממתין · עוד {remaining} ימי מסחר</span>'

        rows_html.append(
            f'<tr>'
            f'<td align="right" style="padding:8px 10px;font-weight:700;color:#2d3748;font-size:12px;text-align:right;white-space:nowrap;">{fmt_iso_short(anchor)}</td>'
            f'<td align="right" style="padding:8px 10px;color:{col(actual5)};font-weight:700;font-family:monospace;font-size:12px;text-align:right;">{fmt_pct(actual5)}</td>'
            f'<td align="right" style="padding:8px 10px;color:{col(fc5)};font-weight:700;font-family:monospace;font-size:12px;text-align:right;">{fmt_pct(fc5)}</td>'
            f'<td align="right" style="padding:8px 10px;font-size:11px;text-align:right;">{track_html}</td>'
            f'<td align="right" style="padding:8px 10px;color:#4a5568;font-size:12px;text-align:right;white-space:nowrap;">{fmt_iso_short(target20_iso)}</td>'
            f'<td align="right" style="padding:8px 10px;color:{fc20_color};font-weight:700;font-family:monospace;font-size:12px;text-align:right;">{fc20_cell}</td>'
            f'<td align="right" style="padding:8px 10px;font-size:11px;text-align:right;">{verdict_cell}</td>'
            f'<td align="right" style="padding:8px 10px;color:#4a5568;font-size:12px;text-align:right;">{hit_str}</td>'
            f'<td align="right" style="padding:8px 10px;color:#4a5568;font-size:11px;text-align:right;">{matches_str}</td>'
            f'</tr>'
        )
        if fc20 is not None and not dead_zone:
            all_fc20.append(fc20)

    if total_rows == 0 and not skipped_dates:
        return ''

    # Summary row
    summary_html = ''
    if total_rows > 0:
        def median_of(arr):
            s = sorted(arr)
            m = len(s) // 2
            return s[m] if len(s) % 2 else (s[m-1] + s[m]) / 2
        def fmt_pct(v):
            return '—' if v is None else f'{"+" if v >= 0 else ""}{v:.2f}%'
        def col(v):
            if v is None: return '#64748b'
            return '#10b981' if v > 0 else ('#ef4444' if v < 0 else '#64748b')
        all_med = median_of(all_fc20) if all_fc20 else None
        track5_txt = (f'🟢 {within5} בתוך התרחיש'
                      + (f' · 🔴 {break5} חריגות' if break5 else '')
                      + (f' · 🔵 {surprise5} הפתעות' if surprise5 else ''))
        verdict20_txt = (f'{in_range20} מתוך {judged20} בתוך הטווח החזוי'
                         if judged20 else 'אף תבנית טרם הגיעה ליום 20')
        summary_html = (
            f'<tr style="background:#f7fafc;border-top:2px solid #cbd5e0;">'
            f'<td colspan="3" align="right" style="padding:8px 10px;font-weight:700;color:#2d3748;font-size:12px;text-align:right;">סיכום ({total_rows} שורות)</td>'
            f'<td align="right" style="padding:8px 10px;font-weight:700;color:#2d3748;font-size:11px;text-align:right;">{track5_txt}</td>'
            f'<td align="right" style="padding:8px 10px;font-weight:700;color:#2d3748;font-size:11px;text-align:right;">חציון אינדיקציה</td>'
            f'<td align="right" style="padding:8px 10px;color:{col(all_med)};font-weight:700;font-family:monospace;font-size:12px;text-align:right;">{fmt_pct(all_med)}</td>'
            f'<td align="right" style="padding:8px 10px;font-weight:700;color:#2d3748;font-size:11px;text-align:right;">{verdict20_txt}</td>'
            f'<td colspan="2"></td>'
            f'</tr>'
        )

    # Skipped (insufficient-match) snapshots — disclosed once, thin.
    skipped_html = ''
    if skipped_dates:
        skipped_html = (
            f'<tr>'
            f'<td colspan="9" align="right" style="padding:8px 10px;font-size:11px;color:#a0aec0;font-style:italic;text-align:right;border-top:1px dashed #e2e8f0;">'
            f'🚫 {len(skipped_dates)} תבניות הוסרו — לא נמצאו מספיק ימים דומים: {", ".join(skipped_dates)}'
            f'</td></tr>'
        )

    return f"""
<div dir="rtl" style="{CARD}padding:20px 22px;text-align:right;">
  <div style="font-size:11px;color:#718096;letter-spacing:0.1em;text-transform:uppercase;font-weight:600;margin-bottom:6px;text-align:right;">תבניות שעברו 5 ימי בחינה — מעקב ביניים + פסיקת יום 20</div>
  <div style="font-size:12px;color:#718096;margin-bottom:12px;text-align:right;">{total_rows} תבניות · מעקב 5 ימים: {within5} בתוך התרחיש, {break5} חריגות · יום 20: {f"{in_range20}/{judged20} בטווח" if judged20 else "ממתין"}</div>
  <table dir="rtl" style="width:100%;border-collapse:collapse;direction:rtl;font-size:12px;">
    <thead>
      <tr style="background:#edf2f7;">
        <th align="right" style="padding:8px 10px;font-size:11px;color:#4a5568;font-weight:700;text-align:right;">תאריך תפיסה</th>
        <th align="right" style="padding:8px 10px;font-size:11px;color:#4a5568;font-weight:700;text-align:right;">בפועל 5d</th>
        <th align="right" style="padding:8px 10px;font-size:11px;color:#4a5568;font-weight:700;text-align:right;">אינדיקציה 5d</th>
        <th align="right" style="padding:8px 10px;font-size:11px;color:#4a5568;font-weight:700;text-align:right;">מעקב 5d</th>
        <th align="right" style="padding:8px 10px;font-size:11px;color:#4a5568;font-weight:700;text-align:right;">תאריך יעד 20d</th>
        <th align="right" style="padding:8px 10px;font-size:11px;color:#4a5568;font-weight:700;text-align:right;">אינדיקציה 20d</th>
        <th align="right" style="padding:8px 10px;font-size:11px;color:#4a5568;font-weight:700;text-align:right;">בפועל 20d · פסיקה</th>
        <th align="right" style="padding:8px 10px;font-size:11px;color:#4a5568;font-weight:700;text-align:right;">סיכוי 20d</th>
        <th align="right" style="padding:8px 10px;font-size:11px;color:#4a5568;font-weight:700;text-align:right;">התאמות</th>
      </tr>
    </thead>
    <tbody>{''.join(rows_html)}{summary_html}{skipped_html}</tbody>
  </table>
  <div style="font-size:10px;color:#a0aec0;margin-top:10px;line-height:1.5;text-align:right;">
    "מעקב 5d" = האם תנועת 5 הימים בפועל נמצאת בתוך טווח התוצאות של 10 האנלוגים ההיסטוריים (דיפ בתוך הטווח אינו שובר את התבנית). "פסיקת יום 20" = המבחן הסופי — האם התשואה בפועל ביום ה-20 נפלה בטווח החזוי. "סיכוי" = כמה מהאנלוגים נסגרו בחיובי ביום ה-20.
  </div>
</div>
"""

s_matured_html = matured_patterns_block_html()

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

# ─── Risk-Off banner (sits at the very top when triggered) ──
def risk_off_block_html():
    if not risk_off_reasons:
        return ''
    # Redesigned pressure card — the SAME three fixed lines as the
    # dashboard (state / evidence / action), built from the shared
    # build_pressure_* helpers. No date list, no live line, no footer,
    # no green-close bullet. The email has no dot bar — text only.
    acute = bool(risk_off_acute)
    state_line = build_pressure_state_line(c_score, acute)
    evidence_line = build_pressure_evidence_line(dist_days, sell_days_10)
    action_line = build_pressure_action(c_score, dist_days, sell_days_3, acute)
    icon = '🚨' if acute else '⚠️'
    # Acute → the whole card goes red; background stays slate.
    bg = ('linear-gradient(135deg,#7f1d1d,#991b1b)' if acute
          else 'linear-gradient(135deg,#1e293b,#334155)')
    border = 'rgba(248,113,113,0.45)' if acute else 'rgba(241,245,249,0.12)'
    return f"""
<div dir="rtl" style="background:{bg};color:#f1f5f9;border-radius:10px;padding:18px 22px;margin-bottom:12px;direction:rtl;text-align:right;border:1px solid {border};">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;text-align:right;direction:rtl;">
    <span style="font-size:22px;">{icon}</span>
    <span style="font-size:15px;font-weight:800;">{state_line}</span>
  </div>
  <div style="font-size:13px;color:#e2e8f0;line-height:1.6;margin-bottom:10px;text-align:right;direction:rtl;">{evidence_line}</div>
  <div style="font-size:13px;color:#f1f5f9;line-height:1.6;text-align:right;direction:rtl;padding-top:8px;border-top:1px solid rgba(241,245,249,0.15);"><b>המשמעות:</b> {action_line}</div>
</div>
"""

s_risk_off_html = risk_off_block_html()

# ─── Verdict — Python mirror of v2/verdict.js buildVerdict ────────────
# Single source for BOTH the email banner and data/daily_state.json.
# (_score_light is defined up by combined(), which needs it for the
#  contradiction penalty.)
def _vol_light():
    # VIX level + 1-day move …
    base = 'na'
    if vix:
        if vix >= 25 or (vix_chg_pct is not None and vix_chg_pct >= 25):
            base = 'neg'
        elif vix >= 20 or (vix_chg_pct is not None and vix_chg_pct >= 10):
            base = 'warn'
        else:
            base = 'pos'
    # … combined with the VIX term structure (phase 3.2): backwardation
    # (VIX/VIX3M >= 1) = acute near-term fear; 0.9-1.0 = flattening.
    term = 'na'
    if vix_term_ratio is not None:
        term = 'neg' if vix_term_ratio >= 1.0 else 'warn' if vix_term_ratio >= 0.9 else 'pos'
    order = {'na': -1, 'pos': 0, 'warn': 1, 'neg': 2}
    worst = max((base, term), key=lambda x: order[x])
    return worst


def compute_eq_spx_spread():
    """20-session EQ500-minus-SPX spread (percentage points). This is a
    *breadth* measure — equal-weight lagging cap-weight = leadership
    narrowing to mega-caps. Moved out of the rotation light into the
    Breadth evidence card (review fix 2). Returns None if too little
    history."""
    h = history_rich
    if len(h) < 21:
        return None
    spx_now, spx_20 = h[-1].get('spx_price'), h[-21].get('spx_price')
    if not spx_now or not spx_20:
        return None
    spx_ret = (spx_now / spx_20 - 1) * 100
    eq = 1.0
    for d in h[-20:]:
        ac = d.get('avg_change')
        if ac is not None:
            eq *= (1 + ac / 100)
    return round((eq - 1) * 100 - spx_ret, 2)   # EQ500 minus SPX, 20 sess


def _spx_return(n):
    """$SPX % return over the last n sessions (price[-1] / price[-1-n])."""
    h = history_rich
    if len(h) < n + 1:
        return None
    a, b = h[-1].get('spx_price'), h[-1 - n].get('spx_price')
    return (a / b - 1) * 100 if (a and b) else None


def _sector_return(code, n):
    """Sector cumulative % return over the last n sessions, compounding
    the per-day sector average change. Aligned with _spx_return: the n
    daily changes in h[-n:] carry price from h[-1-n]'s close to h[-1]'s."""
    h = history_rich
    if len(h) < n + 1:
        return None
    r, seen = 1.0, 0
    for d in h[-n:]:
        sc = (d.get('sector_chg') or {}).get(code)
        if sc is not None:
            r *= (1 + sc / 100)
            seen += 1
    return (r - 1) * 100 if seen else None


def compute_sector_rs():
    """Per-sector relative strength vs $SPX on the 5- and 20-session
    windows (review fix 2 / Rotation v2). RS = sector return − SPX return.
    A sector is 'Leading' when RS > 0 on BOTH windows — real, persistent
    outperformance, not a one-day pop. Returns {code: {rs5, rs20,
    leading}} for every sector present in the history."""
    s5, s20 = _spx_return(5), _spx_return(20)
    codes = set()
    for d in history_rich:
        codes.update((d.get('sector_chg') or {}).keys())
    out = {}
    for code in codes:
        r5, r20 = _sector_return(code, 5), _sector_return(code, 20)
        rs5 = round(r5 - s5, 2) if (r5 is not None and s5 is not None) else None
        rs20 = round(r20 - s20, 2) if (r20 is not None and s20 is not None) else None
        out[code] = {
            'rs5': rs5,
            'rs20': rs20,
            'leading': bool(rs5 is not None and rs5 > 0 and
                            rs20 is not None and rs20 > 0),
        }
    return out


def leading_sectors(sector_rs=None):
    """Codes of Leading sectors (RS>0 on both windows), strongest first
    by 20-session RS."""
    rs = sector_rs if sector_rs is not None else compute_sector_rs()
    lead = [(c, d) for c, d in rs.items() if d.get('leading')]
    lead.sort(key=lambda cd: (cd[1].get('rs20') or 0), reverse=True)
    return [c for c, _ in lead]


def compute_rotation_series(n=20):
    """Cumulative cyclical-minus-defensive daily-change spread over the
    last n sessions (review fix 2). Rising = cyclicals pulling ahead of
    defensives (risk-on rotation); falling = money rotating to safety.
    Gives the Rotation evidence card a real time series to sparkline."""
    h = history_rich[-n:]
    out, cum = [], 0.0
    for d in h:
        sc = d.get('sector_chg') or {}
        cyc = [sc[c] for c in CYCLICAL_SECTORS if c in sc]
        dfn = [sc[c] for c in DEFENSIVE_SECTORS if c in sc]
        if cyc and dfn:
            cum += sum(cyc) / len(cyc) - sum(dfn) / len(dfn)
        out.append(round(cum, 3))
    return out


def compute_rotation_light(sector_rs=None):
    """TRUE sectoral-rotation light (review fix 2). Green when risk-on
    leadership is broad (≥3 cyclical sectors Leading), red when the money
    rotates into defensives (defensives lead and cyclicals do not),
    yellow otherwise. Replaces the old EQ-vs-SPX spread, which was a
    second breadth measure — that now lives in the Breadth card."""
    rs = sector_rs if sector_rs is not None else compute_sector_rs()
    lead = [c for c, d in rs.items() if d.get('leading')]
    if not lead and len(history_rich) < 21:
        return 'na'
    cyc = sum(1 for c in lead if c in CYCLICAL_SECTORS)
    dfn = sum(1 for c in lead if c in DEFENSIVE_SECTORS)
    if cyc >= 3:
        return 'pos'        # broad risk-on leadership → healthy rotation
    if dfn >= 2 and cyc <= 1:
        return 'neg'        # money hiding in defensives → risk-off rotation
    return 'warn'


def build_conclusion():
    """The daily thinking layer: Analysis → Conclusion → Recommendation,
    SYNTHESIZED from all four data domains (price/trend, breadth,
    volatility, options flow) plus rotation and pressure — instead of a
    score-band lookup that reads the same every day. DISPLAY ONLY: no
    scoring change, no FORMULA_VERSION bump. Emitted to daily_state so the
    dashboard and email render one thought."""
    if c_score is None:
        return None
    C, T, B, F = c_score, t_score, b_score, f_score
    acute = bool(risk_off_acute)
    hr = history_rich

    # ── raw signals across the domains ──
    eq_today  = hr[-1].get('avg_change')  if hr else None
    spx_today = hr[-1].get('spx_chg_pct') if hr else None
    day_narrow = (eq_today is not None and spx_today is not None
                  and spx_today > 0 and (spx_today - eq_today) >= 0.4)
    spread20 = compute_eq_spx_spread()
    p200_r = round(p200)
    p50_r  = round(a50 / total * 100) if total else None
    rs = compute_sector_rs()
    lead = leading_sectors(rs)
    cyc = sum(1 for c in lead if c in CYCLICAL_SECTORS)
    dfn = sum(1 for c in lead if c in DEFENSIVE_SECTORS)
    rot_light = compute_rotation_light(rs)
    lead_names = ' · '.join(SECTOR_NAMES.get(c, c) for c in lead) or '—'
    broad_days = count_spx_above_ma200(hr)
    fdir = flow_direction
    pc = flow.get('pc_p') if flow else None
    mid = flow.get('midPct') if flow else None

    # ── cooling signals: internal weakness beneath a strong tape ──
    cooling = []
    if day_narrow:
        cooling.append(f'עלייה צרה (שוויוני {eq_today:+.2f}% מול מדד {spx_today:+.2f}%)')
    if spread20 is not None and spread20 < -0.5:
        cooling.append(f'פער EQ-SPX שלילי ({spread20:+.1f}% ב-20 יום)')
    if dfn >= 2 and cyc <= 1:
        cooling.append(f'מנהיגות הגנתית ({lead_names})')
    elif rot_light == 'warn' and cyc <= 1:
        cooling.append(f'מנהיגות מצטמצמת ({lead_names})')
    # Options: use the DIRECTIONAL Flow score, not raw P/C (which is
    # Mid-contaminated and can contradict the directional read — that
    # exact incoherence is what we're removing).
    if F is not None and F < 48:
        cooling.append(f'אופציות הגנתיות (Flow {F})')
    if dist_days >= 4:
        cooling.append(f'{dist_days} ימי מכירה ב-25')

    # ── Smart-money cross-check (runs in EVERY state) ──
    # Does the OPTIONS FLOW confirm the price, or fight it? A divergence
    # between price and flow is the most valuable "thinking" signal:
    # dip-buying INTO a sell-off, or distribution INTO a rally. The same
    # down day means two different things depending on the flow.
    # Price direction: an acute day IS a down event (the crash dominates);
    # otherwise take the prevailing regime from the combined score (daily
    # noise excluded). Mutually exclusive by construction.
    if acute:
        price_up, price_down = False, True
    else:
        price_up   = C is not None and C >= 55
        price_down = C is not None and C < 45
    flow_bull  = F is not None and F >= 55
    flow_bear  = F is not None and F < 45
    divergence, div_note = None, ''
    if price_down and flow_bull:
        divergence = 'dip_buying'
        div_note = f'זרימת האופציות שורית (Flow {F}) — הכסף הגדול קונה לתוך הירידה, כנראה קניית דיפ ולא מכירה רגילה'
    elif price_up and flow_bear:
        divergence = 'distribution'
        div_note = f'זרימת האופציות דובית (Flow {F}) — הכסף הגדול מוכר לתוך העלייה; אזהרת דיסטריביושן'
    elif price_up and flow_bull:
        divergence = 'confirm_up'
        div_note = f'האופציות מאשרות את העלייה (Flow {F} שורי)'
    elif price_down and flow_bear:
        divergence = 'confirm_down'
        div_note = f'האופציות מאשרות את החולשה (Flow {F} דובי)'

    # ── market state (drives the conclusion) ──
    improving = (narrative_metrics.get('breadth5dDelta') or 0) > 0
    if acute:
        state = 'acute'
    elif C >= 60:
        state = 'narrow_strength' if cooling else 'confirmed_strength'
    elif C < 45:
        state = 'weak_stabilizing' if improving else 'weak_expanding'
    else:
        state = 'chop'

    # ── ANALYSIS — one factual line per data domain ──
    def _btone(pos_ok, neg_bad):
        return 'pos' if pos_ok else ('neg' if neg_bad else 'warn')
    analysis = []
    analysis.append({'domain': 'מחיר ומגמה',
        'text': f'SPX מעל MA200 כבר {broad_days} ימי מסחר · ציון טכני {T}.',
        'tone': _btone(T is not None and T >= 60, T is not None and T < 40)})
    btxt = f'{p200_r}% מהמניות מעל MA200'
    if day_narrow:
        btxt += f' — אך היום העלייה צרה (שוויוני {eq_today:+.2f}% מול {spx_today:+.2f}%)'
    analysis.append({'domain': 'רוחב', 'text': btxt + '.',
        'tone': 'warn' if day_narrow else _btone((p200 or 0) >= 55, (p200 or 0) < 40)})
    if vix is not None:
        vtxt = f'VIX {vix:.1f} · ' + ('רגוע' if vix < 20 else 'לחוץ')
        vtone = 'pos' if vix < 20 else 'warn' if vix < 25 else 'neg'
    else:
        vtxt, vtone = 'VIX —', 'warn'
    analysis.append({'domain': 'תנודתיות', 'text': vtxt + '.', 'tone': vtone})
    if F is not None:
        # The directional Flow score is canonical; raw P/C is Mid-
        # contaminated and dropped here to avoid a misleading "60 offensive
        # · P/C 1.29 defensive" side-by-side.
        otxt = f'Flow {F} ({fdir["label"]})'
        if mid is not None: otxt += f' · {round(mid)}% Mid'
        otone = _btone(F >= 55, F < 45)
    else:
        otxt, otone = 'אין נתוני אופציות היום', 'warn'
    analysis.append({'domain': 'אופציות', 'text': otxt + '.', 'tone': otone})
    analysis.append({'domain': 'רוטציה',
        'text': f'מובילים: {lead_names} (מחזוריים {cyc} / הגנתיים {dfn}).',
        'tone': 'pos' if rot_light == 'pos' else 'neg' if rot_light == 'neg' else 'warn'})
    analysis.append({'domain': 'לחץ',
        'text': f'{dist_days} ימי מכירה ב-25 · {sell_days_3} ב-3 האחרונים.',
        'tone': 'neg' if dist_days >= 4 else 'warn' if dist_days >= 2 else 'pos'})

    # ── CONCLUSION — synthesis per state, with the smart-money cross-check ──
    if state == 'acute':
        base = f'יום סיכון — אירוע מכירה חד היום ({_acute_reason() or "ירידה חדה"}).'
        if divergence == 'dip_buying':
            conclusion = base + f' אבל {div_note} — זו לא ירידה רגילה.'
        elif divergence == 'confirm_down':
            conclusion = base + f' {div_note} — הכסף הגדול בורח יחד עם המחיר, אישור חולשה.'
        else:
            conclusion = base + ' הבאנר האדום מתריע; זו העדיפות היום.'
    elif state == 'confirmed_strength':
        conclusion = (f'השוק חזק ומאושר מבפנים: מחיר במגמת-על (טכני {T}), רוחב רחב '
                      f'({p200_r}% מעל MA200), והמנהיגות והאופציות תומכות. עלייה מגובה.')
    elif state == 'narrow_strength':
        conclusion = ('השוק חזק כלפי חוץ אבל מתקרר מבפנים — ' + ' · '.join(cooling[:3])
                      + '. עלייה לא-מאושרת: חוזק מחיר שאינו מגובה ברוחב פנימי.')
        if divergence == 'distribution':
            conclusion += f' יתרה מכך — {div_note}.'
    elif state == 'weak_stabilizing':
        conclusion = (f'חולשה עם סימני התייצבות: ציון משולב {C}, אך הרוחב משתפר. '
                      'ייתכן תהליך תחתית — עדיין לא איתות כניסה.')
        if divergence == 'dip_buying':
            conclusion += f' תומך בכך: {div_note}.'
    elif state == 'weak_expanding':
        conclusion = (f'חולשה מתרחבת: ציון משולב {C}, הרוחב יורד והמנהיגות הגנתית. לחץ שנמשך.')
        if divergence == 'dip_buying':
            conclusion += f' סימן מנוגד יחיד: {div_note} — לעקוב אחרי התייצבות.'
    else:
        conclusion = (f'חוסר הכרעה: ציון משולב {C}, הסיגנלים מפוצלים ואין כיוון ברור.')
        if divergence in ('dip_buying', 'distribution'):
            conclusion += f' {div_note}.'

    # ── RECOMMENDATION — action + the specific triggers that flip it ──
    REC = {
        'acute':              ('לא קונים היום — עד שהשוק מתייצב.', 'יום מסחר יציב', 'ירידה חדה נוספת'),
        'confirmed_strength': ('להחזיק ולהוסיף חשיפה במנות מדודות.', 'המשך רוחב חיובי', 'רוטציה נהפכת הגנתית או Flow מתחת ל-45'),
        'narrow_strength':    ('להחזיק קיים · לא להוסיף חשיפה חדשה · להדק סטופים על החלשות.',
                               'המדד השוויוני מדביק (רוחב מתרחב) + Flow מעל ~58',
                               'יום מכירה נוסף או %MA50 מתחת ל-65%'),
        'weak_stabilizing':   ('להמתין לאישור — לא להיכנס עדיין.', 'רוחב ו-Flow ממשיכים לעלות', 'חזרה לירידות'),
        'weak_expanding':     ('הגנה — לקצץ חשיפה בהדרגה, עדיפות למזומן.', 'התייצבות ברוחב', 'המשך הידרדרות'),
        'chop':               ('להמתין לאיתות ברור לפני פעולה.', 'פריצה ברורה + Flow תומך', 'שבירה כלפי מטה'),
    }
    action, improve, worsen = REC[state]
    # Acute day: the action stays conservative (don't catch a falling
    # knife), but the triggers change with the flow — dip-buying flips the
    # framing to "watch for the entry", confirmed-down to "full defense".
    if state == 'acute' and divergence == 'dip_buying':
        action  = 'לא קונים היום — לא רודפים ירידה, אבל לא מוכרים בפאניקה.'
        improve = 'התייצבות מחר + Flow נשאר מעל 55 → נקודת כניסה מוקדמת'
        worsen  = 'המשך ירידה + Flow מתהפך לדובי → הגנה מלאה'
    elif state == 'acute' and divergence == 'confirm_down':
        action  = 'הגנה — לקצץ חשיפה, לא לחפש תחתית עדיין.'
    recommendation = {'action': action, 'improve': improve, 'worsen': worsen}

    # ── CONVICTION — how much price and internals agree ──
    if state in ('acute', 'confirmed_strength', 'weak_expanding'):
        conviction = 'high'
    elif state == 'chop':
        conviction = 'low'
    else:
        conviction = 'medium'
    # A price↔flow divergence means the signals disagree — never claim high
    # conviction when the smart money is fighting the tape.
    if divergence in ('dip_buying', 'distribution') and conviction == 'high':
        conviction = 'medium'

    # ── INSIGHT — the single sharpest signal today (salience-ranked) ──
    cands = []
    if day_narrow:
        cands.append((abs(spx_today - eq_today) * 3,
            f'פער המדד השוויוני מול המדד נפתח ל-{spx_today - eq_today:.2f}% היום — העלייה על קומץ מניות.'))
    if flow_streak >= 3:
        cands.append((flow_streak,
            f'{fdir["label"]} כבר {flow_streak} ימים מול הממוצע החודשי — מגמה נמשכת באופציות.'))
    if spread20 is not None:
        cands.append((abs(spread20),
            f'פער EQ-SPX ל-20 יום {spread20:+.1f}% — ' + ('רוחב רחב' if spread20 >= 0 else 'ראלי צר')))
    if dfn >= 2 and cyc <= 1:
        cands.append((4, f'המנהיגות דפנסיבית ({lead_names}) — בריחה למקלטים.'))
    if sell_days_3 >= 2:
        cands.append((sell_days_3 * 1.5, f'{sell_days_3} ימי מכירה ב-3 הימים האחרונים — קיבוץ הדוק.'))
    insight = max(cands, key=lambda x: x[0])[1] if cands else ''

    # ── CHANGE — what moved since the previous trading day ──
    change = []
    try:
        if len(flow_files) >= 2 and F is not None:
            f_prev = _flow_score_from_file(flow_files[-2])
            if f_prev is not None and abs(F - f_prev) >= 4:
                change.append(f'Flow {f_prev}→{F} {"↑" if F > f_prev else "↓"}')
    except Exception:
        pass
    try:
        if len(hr) >= 2:
            b_prev = hr[-2].get('pct_ma200')
            if b_prev is not None and abs(p200 - b_prev) >= 2:
                change.append(f'רוחב {round(b_prev)}%→{p200_r}% {"↑" if p200 > b_prev else "↓"}')
    except Exception:
        pass

    return {
        'state': state,
        'analysis': analysis,
        'conclusion': conclusion,
        'recommendation': recommendation,
        'conviction': conviction,
        'insight': insight,
        'change': change,
    }


def build_verdict_state():
    """Structured verdict: {headline, subline, tone, emoji, lights}. Same
    score-band branching as the dashboard (acute / background / bands +
    phase). Rotation light is 'na' until phase 3.2."""
    c = c_score
    acute = bool(risk_off_acute)
    background = bool(risk_off_reasons) and not acute
    reasons_txt = ' · '.join(risk_off_reasons)
    if acute:
        tone, emoji = 'neg', '🔴'
        headline, subline = 'יום סיכון — לא להוסיף חשיפה', reasons_txt
    elif background:
        if c is not None and c >= 55:
            tone, emoji = 'warn', '🟡'
            headline = 'השוק יציב — אך עם לחץ מכירות מצטבר, בזהירות'
        else:
            tone, emoji = 'neg', '🔴'
            headline = 'חולשה מצטברת — להישאר בהגנה'
        subline = reasons_txt
    elif c is None:
        tone, emoji, headline, subline = 'warn', '🟡', 'אין מספיק נתונים', ''
    elif c >= 70:
        tone, emoji = 'pos', '🟢'
        headline = 'השוק בריא — אפשר להמשיך בגישת long'
        subline = f'ציון משולב {c}/100 · לעקוב אחרי VIX ורוחב'
    elif c >= 55:
        tone, emoji = 'warn', '🟡'
        headline = 'השוק יציב — להמשיך בזהירות'
        subline = f'ציון משולב {c}/100 · מצב מבני סביר, לא בוטח בעלייה רחבה'
    elif c >= 40:
        tone, emoji = 'warn', '🟡'
        headline = 'מצב מעורב — להמתין לסיגנל ברור'
        subline = f'ציון משולב {c}/100 · ללא הכרעה בכיוון'
    else:
        tone, emoji = 'neg', '🔴'
        headline = 'מצב חלש — להישאר בהגנה'
        subline = f'ציון משולב {c}/100 · אינדיקטורים מבניים מצטברים שליליים'
    if phase_label_now and phase_label_now != 'לא ידוע' and phase_label_now not in subline:
        subline = (subline + ' · ' if subline else '') + phase_label_now
    # Phase 3.3 — surface the contradiction penalty in the bottom line.
    if contradiction_penalty:
        subline = (subline + ' · ' if subline else '') + f'עלייה צרה — הציון נחתך {contradiction_penalty} נק׳'
    return {
        'headline': headline, 'subline': subline, 'tone': tone, 'emoji': emoji,
        'lights': {
            'trend': _score_light(t_score),
            'breadth': _score_light(b_score),
            'volatility': _vol_light(),
            'rotation': compute_rotation_light(),
        },
    }


DASHBOARD_URL = 'https://nditzik.github.io/indexes-status/index-v3.html'
_LIGHT_EMOJI = {'pos': '🟢', 'warn': '🟡', 'neg': '🔴', 'na': '⚪'}
_LIGHT_LABEL = {'trend': 'מגמה', 'breadth': 'רוחב', 'volatility': 'תנודתיות', 'rotation': 'רוטציה'}


def build_verdict_banner():
    v = build_verdict_state()
    headline, subline, tone, emoji = v['headline'], v['subline'], v['tone'], v['emoji']
    color = {'pos': '#10b981', 'warn': '#f59e0b', 'neg': '#ef4444'}[tone]
    lights = v.get('lights', {})
    # Phase 4.2 — mirror the dashboard's Verdict layout: lights row + a
    # link to the full dashboard, under the headline.
    lights_html = ' &nbsp; '.join(
        f"{_LIGHT_EMOJI.get(lights.get(k, 'na'), '⚪')} {_LIGHT_LABEL[k]}"
        for k in ('trend', 'breadth', 'volatility', 'rotation')
    )
    return f"""
<div dir="rtl" style="{CARD}padding:16px 20px;margin-bottom:12px;border-right:4px solid {color};text-align:right;direction:rtl;">
  <div style="display:flex;align-items:center;gap:10px;text-align:right;direction:rtl;">
    <span style="font-size:20px;">{emoji}</span>
    <span style="font-size:17px;font-weight:800;color:{color};line-height:1.25;">{headline}</span>
  </div>
  <div style="font-size:12px;color:#718096;margin-top:6px;text-align:right;">{subline}</div>
  <div style="font-size:13px;margin-top:10px;text-align:right;direction:rtl;">{lights_html}</div>
  <div style="margin-top:12px;text-align:right;">
    <a href="{DASHBOARD_URL}" style="display:inline-block;background:{color};color:#fff;font-size:12px;font-weight:700;text-decoration:none;padding:8px 16px;border-radius:6px;">לדשבורד המלא ←</a>
  </div>
</div>
"""

s_verdict_html = build_verdict_banner()

def knn_outlier_flag_html():
    try:
        with open('data/forward_snapshots.json', 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception:
        return ''
    snaps = data.get('snapshots') or []
    if not snaps:
        return ''
    latest = snaps[-1]
    matches = latest.get('matches') or []
    if not matches:
        return ''
    quality = classify_match_quality(latest)
    if quality['tier'] == 'insufficient':
        # Strong message — model can't help
        return f"""
<div dir="rtl" style="background:#fee2e2;color:#7f1d1d;border-radius:8px;padding:14px 18px;margin-bottom:12px;border:1px solid #fca5a5;direction:rtl;text-align:right;font-size:13px;line-height:1.6;">
  <div style="font-weight:800;font-size:14px;margin-bottom:6px;">⛔ לא מצאתי ימים דומים מספיק</div>
  רק <b>{quality['goodCount']}/10 התאמות במרחק ≤ {MATCH_GOOD_THRESHOLD:.1f}</b> (סף האיכות). המצב הנוכחי <b>נדיר היסטורית</b> — המודל לא יכול להציע אינדיקציה היסטורית אמינה. <b>אינדיקציות 5/10/20 ימים מוסתרות בטבלת המאומתים</b>. להישען על אינדיקטורים אחרים (Tech, Flow, Breadth).
</div>
"""
    # Soft warning when nearest match still further than typical
    nearest = matches[0].get('distance')
    if nearest is not None and nearest > 0.7:
        return f"""
<div dir="rtl" style="background:#fef3c7;color:#92400e;border-radius:8px;padding:12px 16px;margin-bottom:12px;border:1px solid #fcd34d;direction:rtl;text-align:right;font-size:13px;">
  <b>⚠ ההתאמה הקרובה ביותר ב-{nearest:.2f} מרחק (טיפוסי ≤ 0.5).</b> 10 ימים דומים נמצאו אבל מעט רחוקים מהרגיל — המודל פחות בטוח. לקחת את התחזיות עם זהירות.
</div>
"""
    return ''

s_knn_outlier_html = knn_outlier_flag_html()

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

  {s_risk_off_html}
  {s_verdict_html}
  {s_state_html}
  {s_summary_html}
  {s_hist_html}
  {s_knn_outlier_html}
  {s_matured_html}
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

# Recipient resolution — see README §audit-fix-7
#   tier 1: TEST_RECIPIENTS env var (manual test workflow)
#   tier 2: EMAIL_SUBSCRIBERS env var (GitHub Secret, JSON array or CSV)
#   tier 3: data/email_subscribers.json file (gitignored)
#   tier 4: error out — no hardcoded list any more.
def _load_recipients():
    _test = os.environ.get("TEST_RECIPIENTS", "").strip()
    if _test:
        emails = [e.strip() for e in _test.split(",") if e.strip()]
        print(f"TEST MODE — sending only to: {emails}")
        return [{"email": e} for e in emails], "🧪 [TEST] "
    env_subs = os.environ.get("EMAIL_SUBSCRIBERS", "").strip()
    if env_subs:
        emails = None
        try:
            parsed = json.loads(env_subs)
            if isinstance(parsed, list):
                emails = [str(e).strip() for e in parsed if str(e).strip()]
        except (json.JSONDecodeError, ValueError):
            emails = [e.strip() for e in env_subs.split(",") if e.strip()]
        if emails:
            print(f"Loaded {len(emails)} recipients from EMAIL_SUBSCRIBERS env var")
            return [{"email": e} for e in emails], "📊 "
    try:
        with open("data/email_subscribers.json", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list) and data:
            emails = [str(e).strip() for e in data if str(e).strip()]
            print(f"Loaded {len(emails)} recipients from data/email_subscribers.json")
            return [{"email": e} for e in emails], "📊 "
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"WARN: failed to read data/email_subscribers.json: {e}")
    raise SystemExit(
        "ERROR: no email recipients configured. Set EMAIL_SUBSCRIBERS env var "
        "(JSON array or comma-separated) or create data/email_subscribers.json."
    )

# Formula version stamp for the append-only history. Bump on any scoring
# change; NEVER rewrite past rows. Module-level so build_daily_state can
# import it. See phase-2.4 / phase-3.0. Version log:
#   v1 — base weighted composite (0.40 Tech + 0.35 Flow + 0.25 Breadth)
#   v2 — dynamic Flow weight by directional share (phase 3.1)
#   v3 — contradiction penalty: Trend↔Breadth opposite extremes → −10 (phase 3.3)
#   v4 — Flow Ask-aggression denominators exclude Mid (directional only),
#        matching overview-prod.js. Fixes high-Mid days where the old
#        Mid-included denominator diluted the signal (07-02: 54 → 40).
#        Changes the Flow score and therefore Combined.
FORMULA_VERSION = 'v4'


def _append_scores_history():
    """Append today's scores to the append-only history (real CI only).
    Guard: write only on a real send (api_key present AND not a TEST run),
    so parity_test's import and any dry-run never pollute the file.
    Idempotent — a date already recorded is skipped."""
    if not (api_key and not os.environ.get('TEST_RECIPIENTS', '').strip()):
        return
    try:
        _hist_path = 'data/scores_history.json'
        try:
            with open(_hist_path, encoding='utf-8') as _f:
                _sh = json.load(_f)
        except (FileNotFoundError, json.JSONDecodeError):
            _sh = []
        _rec_date = history_rich[-1]['date'] if history_rich else None
        if _rec_date and not any(r.get('date') == _rec_date for r in _sh):
            _sh.append({
                'date': _rec_date,
                'tech': t_score, 'breadth': b_score, 'flow': f_score,
                'combined': c_score, 'phase': phase_id_now,
                'confidence': None, 'coverage': None,   # filled once single-source (phase 3.0)
                'formulaVersion': FORMULA_VERSION,
            })
            _sh.sort(key=lambda r: r.get('date', ''))
            with open(_hist_path, 'w', encoding='utf-8') as _f:
                json.dump(_sh, _f, ensure_ascii=False, indent=2)
            print(f'scores_history: appended {_rec_date}')
        else:
            print(f'scores_history: {_rec_date} already present — skip')
    except Exception as _e:
        print(f'scores_history append failed: {_e}')


def main():
    """Send the daily email + record scores. All side effects live here so
    the module can be IMPORTED (parity_test, build_daily_state) to read the
    computed top-level values without sending anything. See phase-3.0."""
    recipients, subject_prefix = _load_recipients()
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
    _append_scores_history()


if __name__ == '__main__':
    main()
