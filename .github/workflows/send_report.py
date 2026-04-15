import csv, json, os, urllib.request, glob, io

# קרא את ה-CSV
with open('data/data.txt', encoding='utf-8-sig', newline='') as f:
    content = f.read()
content = content.replace('\r\n', '\n').replace('\r', '\n')
reader = csv.DictReader(io.StringIO(content))
all_rows = list(reader)
print(f"Total rows: {len(all_rows)}")

# סנן רק מניות תקינות
stocks = []
for row in all_rows:
    sym = row.get('Symbol','').strip()
    if not sym or not sym.replace('.','').isalnum() or not sym[0].isupper():
        continue
    try:
        latest = float(row.get('Latest', '0').replace('%','').replace('+','') or 0)
        ma200  = float(row.get('200D MA', '0').replace('%','') or 0)
        ma50   = float(row.get('50D MA', '0').replace('%','') or 0)
        ma20   = float(row.get('20D MA', '0').replace('%','') or 0)
        ma150  = float(row.get('150D MA', '0').replace('%','') or 0)
        rvol   = float(row.get('20D RelVol', '0').replace('%','') or 0)
        chg    = row.get('%Change','').strip()
        rsi    = row.get('RSI Rank','').strip()
        w52    = float(row.get('52W %/High', '0').replace('%','') or 0)
    except:
        continue
    if latest <= 0:
        continue
    dist200 = (latest/ma200-1)*100 if ma200 > 0 else None
    # MA score (0-4)
    ma_score = sum([
        1 if ma20 > 0 and latest > ma20 else 0,
        1 if ma50 > 0 and latest > ma50 else 0,
        1 if ma150 > 0 and latest > ma150 else 0,
        1 if ma200 > 0 and latest > ma200 else 0,
    ])
    stocks.append({
        'sym': sym, 'name': row.get('Name','').strip('"'),
        'latest': latest, 'ma200': ma200, 'ma150': ma150, 'ma50': ma50, 'ma20': ma20,
        'rvol': rvol, 'chg': chg, 'rsi': rsi,
        'w52': w52, 'dist200': dist200, 'ma_score': ma_score
    })

print(f"Valid stocks: {len(stocks)}")

# תאריך
files = sorted(glob.glob('data/watchlist-sp-500-intraday-*.csv'))
date_label = files[-1].replace('data/watchlist-sp-500-intraday-','').replace('.csv','') if files else ''

# ── נתוני שוק כלליים ──
total     = len(stocks)
above200  = sum(1 for s in stocks if s['dist200'] is not None and s['dist200'] > 0)
above150  = sum(1 for s in stocks if s['ma150'] > 0 and s['latest'] > s['ma150'])
above50   = sum(1 for s in stocks if s['ma50'] > 0 and s['latest'] > s['ma50'])
above20   = sum(1 for s in stocks if s['ma20'] > 0 and s['latest'] > s['ma20'])
golden    = sum(1 for s in stocks if s['ma50'] > 0 and s['ma200'] > 0 and s['ma50'] > s['ma200'])
advancing = sum(1 for s in stocks if '+' in s['chg'])
declining = sum(1 for s in stocks if s['chg'].startswith('-'))
nh        = sum(1 for s in stocks if s['w52'] >= -5)
nl        = sum(1 for s in stocks if s['w52'] <= -30)
oversold  = sum(1 for s in stocks if s['rsi'] in ('Below 30','New Below 30'))
rsi_above50 = sum(1 for s in stocks if s['rsi'] in ('Above 50','New Above 50','Above 70','New Above 70'))
ratio     = f"{nh/nl:.2f}" if nl > 0 else "∞"
health    = round((above200/total*100)*0.30 + (golden/total*100)*0.25 + (rsi_above50/total*100)*0.25 + (above20/total*100)*0.20) if total else 0

def pct(n): return f"{round(n/total*100,1) if total else 0}%"

# ── סקטורים ──
sectors = {}
for s in stocks:
    sc = s.get('sector','?')
    # נגזור סקטור מהמיפוי
    pass
SECTOR_MAP = {
    'AAPL':'IT','MSFT':'IT','NVDA':'IT','AVGO':'IT','ORCL':'IT','CRM':'IT','AMD':'IT','INTC':'IT','QCOM':'IT','AMAT':'IT','TXN':'IT','ADI':'IT','KLAC':'IT','LRCX':'IT','MCHP':'IT','MU':'IT','IBM':'IT','CSCO':'IT','ADSK':'IT','PANW':'IT','CRWD':'IT','PLTR':'IT','INTU':'IT','NOW':'IT','ADBE':'IT','ANET':'IT','DDOG':'IT','ACN':'IT',
    'UNH':'HC','LLY':'HC','JNJ':'HC','ABBV':'HC','MRK':'HC','TMO':'HC','ABT':'HC','DHR':'HC','BMY':'HC','AMGN':'HC','GILD':'HC','ISRG':'HC','VRTX':'HC','REGN':'HC','MDT':'HC','SYK':'HC','BSX':'HC','ELV':'HC','HUM':'HC','CVS':'HC','CI':'HC','MCK':'HC','ZBH':'HC','BAX':'HC','BDX':'HC','DGX':'HC','HSIC':'HC','CNC':'HC','HCA':'HC','IQV':'HC',
    'JPM':'FIN','BAC':'FIN','WFC':'FIN','GS':'FIN','MS':'FIN','BLK':'FIN','AXP':'FIN','SCHW':'FIN','C':'FIN','USB':'FIN','PNC':'FIN','TFC':'FIN','COF':'FIN','MCO':'FIN','SPGI':'FIN','ICE':'FIN','CME':'FIN','CB':'FIN','AFL':'FIN','ALL':'FIN','HIG':'FIN','MET':'FIN','PRU':'FIN','AIG':'FIN','RF':'FIN','KEY':'FIN','FITB':'FIN','WM':'FIN','BEN':'FIN','IVZ':'FIN','AIZ':'FIN','ACGL':'FIN','CINF':'FIN',
    'AMZN':'CD','TSLA':'CD','HD':'CD','MCD':'CD','NKE':'CD','SBUX':'CD','TGT':'CD','LOW':'CD','TJX':'CD','BKNG':'CD','CMG':'CD','ABNB':'CD','MAR':'CD','HLT':'CD','YUM':'CD','DRI':'CD','EBAY':'CD','ETSY':'CD','DECK':'CD','TKO':'CD',
    'PG':'CS','KO':'CS','PEP':'CS','COST':'CS','WMT':'CS','PM':'CS','MO':'CS','CL':'CS','KMB':'CS','GIS':'CS','K':'CS','HSY':'CS','SJM':'CS','CAG':'CS','KR':'CS','CHD':'CS',
    'XOM':'EN','CVX':'EN','COP':'EN','EOG':'EN','SLB':'EN','PXD':'EN','MPC':'EN','VLO':'EN','PSX':'EN','OXY':'EN','DVN':'EN','HAL':'EN','BKR':'EN','APA':'EN','EQT':'EN','AES':'EN','NRG':'EN',
    'NEE':'UTIL','DUK':'UTIL','SO':'UTIL','D':'UTIL','AEP':'UTIL','EXC':'UTIL','SRE':'UTIL','PEG':'UTIL','ES':'UTIL','AWK':'UTIL',
    'LIN':'MAT','APD':'MAT','ECL':'MAT','SHW':'MAT','FCX':'MAT','NEM':'MAT','PPG':'MAT','VMC':'MAT','MLM':'MAT','IFF':'MAT','WY':'MAT',
    'CAT':'IND','DE':'IND','HON':'IND','UPS':'IND','RTX':'IND','LMT':'IND','GE':'IND','MMM':'IND','BA':'IND','NOC':'IND','GD':'IND','EMR':'IND','ETN':'IND','ITW':'IND','PH':'IND','ROK':'IND','IR':'IND','CARR':'IND','NSC':'IND','CSX':'IND','FDX':'IND','MSI':'IND',
    'GOOGL':'COMM','META':'COMM','NFLX':'COMM','DIS':'COMM','CMCSA':'COMM','T':'COMM','VZ':'COMM','TMUS':'COMM','CHTR':'COMM','EA':'COMM','TTWO':'COMM',
    'AMT':'RE','PLD':'RE','CCI':'RE','EQIX':'RE','PSA':'RE','O':'RE','WELL':'RE','DLR':'RE','SPG':'RE','AVB':'RE','EQR':'RE',
    'BRK.B':'FIN','V':'FIN','MA':'FIN','PYPL':'FIN','FIS':'FIN',
}
SECTOR_HE = {'IT':'טכנולוגיה','HC':'בריאות','FIN':'פיננסים','CD':'צריכה שיקולית','CS':'צריכה בסיסית','EN':'אנרגיה','UTIL':'תשתיות','MAT':'חומרים','IND':'תעשייה','COMM':'תקשורת','RE':'נדל"ן'}

sector_data = {}
for s in stocks:
    sc = SECTOR_MAP.get(s['sym'], '?')
    if sc == '?': continue
    if sc not in sector_data:
        sector_data[sc] = {'total':0,'above200':0,'chg_sum':0,'chg_count':0}
    sector_data[sc]['total'] += 1
    if s['dist200'] is not None and s['dist200'] > 0:
        sector_data[sc]['above200'] += 1
    try:
        cv = float(s['chg'].replace('%','').replace('+',''))
        sector_data[sc]['chg_sum'] += cv
        sector_data[sc]['chg_count'] += 1
    except: pass

def sector_heatmap():
    if not sector_data: return '<p>אין נתונים</p>'
    rows = ''
    for sc in sorted(sector_data, key=lambda x: sector_data[x]['above200']/max(sector_data[x]['total'],1), reverse=True):
        d = sector_data[sc]
        p = round(d['above200']/d['total']*100) if d['total'] else 0
        avg_chg = round(d['chg_sum']/d['chg_count'],2) if d['chg_count'] else 0
        bg = '#276749' if p >= 60 else '#d69e2e' if p >= 40 else '#c53030'
        chg_col = '#276749' if avg_chg > 0 else '#c53030'
        chg_str = f"+{avg_chg}%" if avg_chg > 0 else f"{avg_chg}%"
        name = SECTOR_HE.get(sc, sc)
        rows += (f'<tr>'
                 f'<td style="padding:7px 12px;font-weight:600;">{name}</td>'
                 f'<td style="padding:7px 12px;text-align:center;background:{bg};color:#fff;font-weight:700;border-radius:4px;">{p}%</td>'
                 f'<td style="padding:7px 12px;text-align:center;color:{chg_col};font-weight:600;">{chg_str}</td>'
                 f'<td style="padding:7px 12px;text-align:center;color:#718096;">{d["above200"]}/{d["total"]}</td>'
                 f'</tr>')
    return (f'<table style="width:100%;border-collapse:collapse;font-size:13px;">'
            f'<thead><tr style="background:#2d3748;color:#fff;">'
            f'<th style="padding:9px 12px;text-align:right;">סקטור</th>'
            f'<th style="padding:9px 12px;text-align:center;">מעל 200D MA</th>'
            f'<th style="padding:9px 12px;text-align:center;">שינוי יומי ממוצע</th>'
            f'<th style="padding:9px 12px;text-align:center;">מניות</th>'
            f'</tr></thead><tbody>{rows}</tbody></table>')

def make_table(data, cols, headers, title, color):
    if not data:
        return (f'<div style="margin-bottom:24px;">'
                f'<h3 style="margin:0;font-size:15px;color:#fff;background:{color};padding:10px 14px;border-radius:8px;">{title}</h3>'
                f'<p style="color:#a0aec0;font-size:13px;padding:10px 0;">אין נתונים</p></div>')
    th = ''.join(f'<th style="padding:9px 10px;text-align:{"right" if i<=1 else "center"};">{h}</th>' for i,h in enumerate(headers))
    tbody = ''
    for i, s in enumerate(data[:15]):
        bg = '#f7fafc' if i%2==0 else '#fff'
        tds = ''
        for j, c in enumerate(cols):
            val = s.get(c,'')
            align = 'right' if j<=1 else 'center'
            fw = 'font-weight:700;color:#2b6cb0;' if j==0 else ''
            if c == 'chg':
                col2 = '#276749' if '+' in str(val) else '#c53030'
                tds += f'<td style="padding:7px 10px;text-align:{align};color:{col2};font-weight:600;">{val}</td>'
            elif c == 'dist200':
                sign = '+' if val >= 0 else ''
                col2 = '#276749' if val >= 0 else '#c53030'
                tds += f'<td style="padding:7px 10px;text-align:{align};color:{col2};font-weight:600;">{sign}{val:.1f}%</td>'
            elif c == 'rvol':
                col2 = '#276749' if float(val or 0)>1.2 else '#4a5568'
                tds += f'<td style="padding:7px 10px;text-align:{align};color:{col2};">{float(val):.2f}</td>'
            elif c == 'w52':
                col2 = '#276749' if float(val or 0)>=-5 else '#c53030' if float(val or 0)<=-25 else '#4a5568'
                tds += f'<td style="padding:7px 10px;text-align:{align};color:{col2};">{float(val):.1f}%</td>'
            else:
                tds += f'<td style="padding:7px 10px;text-align:{align};{fw}">{val}</td>'
        tbody += f'<tr style="background:{bg};">{tds}</tr>'
    return (f'<div style="margin-bottom:24px;">'
            f'<h3 style="margin:0;font-size:15px;color:#fff;background:{color};padding:10px 14px;border-radius:8px 8px 0 0;">{title}</h3>'
            f'<table style="width:100%;border-collapse:collapse;font-size:13px;">'
            f'<thead><tr style="background:#2d3748;color:#fff;">{th}</tr></thead>'
            f'<tbody>{tbody}</tbody>'
            f'</table></div>')

# ── Top 10 מומנטום עולה ──
def momentum_score(s):
    score = 0
    if s['dist200'] is not None and s['dist200'] > 0: score += 30
    if s['rsi'] in ('Above 70','New Above 70','Above 50','New Above 50'): score += 25
    if s['w52'] >= -10: score += 20
    if s['rvol'] > 1.2: score += 15
    try:
        if float(s['chg'].replace('%','').replace('+','')) > 0: score += 10
    except: pass
    return score

top_momentum = sorted(stocks, key=momentum_score, reverse=True)[:15]
for s in top_momentum: s['mscore'] = momentum_score(s)
t_momentum = make_table(top_momentum, ['sym','name','mscore','chg','rvol','w52'],
    ['סימול','שם','ציון','שינוי','RVOL','52W%'],
    "🚀 מניות עם מומנטום עולה — Top 15", "#2b6cb0")

# ── מועמדות לריבאונד ──
# RSI חלש/oversold + MA Score >= 1 + RVOL > 1.2
rebound = [s for s in stocks
    if s['rsi'] in ('Below 30','New Below 30','Below 50','New Below 50')
    and s['ma_score'] >= 1
    and s['rvol'] > 1.2
    and s['w52'] < -10]
rebound = sorted(rebound, key=lambda s: (s['ma_score'], s['rvol']), reverse=True)[:15]
t_rebound = make_table(rebound, ['sym','name','chg','rvol','ma_score','w52'],
    ['סימול','שם','שינוי','RVOL','MA Score','52W%'],
    f"💡 מועמדות לריבאונד — RSI חלש + נפח + MA≥1 ({len(rebound)} מניות)", "#744210")

# ── סיכום כללי ──
def summary_section():
    items = [
        ("ציון בריאות שוק",    f"{health}/100",           "#3182ce"),
        ("מעל 200D MA",        f"{pct(above200)} ({above200}/{total})", "#38a169" if above200/total>0.5 else "#e53e3e" if total else "#e53e3e"),
        ("מעל 150D MA",        f"{pct(above150)}",         "#38a169" if total and above150/total>0.5 else "#e53e3e"),
        ("מעל 50D MA",         f"{pct(above50)}",          "#38a169" if total and above50/total>0.5 else "#e53e3e"),
        ("מעל 20D MA",         f"{pct(above20)}",          "#38a169" if total and above20/total>0.5 else "#e53e3e"),
        ("Golden Cross",       f"{pct(golden)}",           "#d69e2e"),
        ("RSI מעל 50",         f"{pct(rsi_above50)}",      "#38a169" if total and rsi_above50/total>0.5 else "#e53e3e"),
        ("RSI מכירת יתר",      f"{oversold} מניות",        "#c53030" if oversold>30 else "#718096"),
        ("עולות / יורדות",     f"{advancing} / {declining}", "#38a169" if advancing>declining else "#e53e3e"),
        ("NH / NL יחס",        f"{nh} / {nl} = {ratio}",  "#38a169" if nl==0 or (nl>0 and nh/nl>=2) else "#e53e3e"),
    ]
    rows = ''.join(
        f'<tr style="background:{"#f7fafc" if i%2==0 else "#fff"};">'
        f'<td style="padding:9px 14px;font-weight:600;color:#4a5568;">{k}</td>'
        f'<td style="padding:9px 14px;font-weight:700;color:{c};font-size:15px;">{v}</td></tr>'
        for i,(k,v,c) in enumerate(items)
    )
    return f'<table style="width:100%;border-collapse:collapse;font-size:14px;"><tbody>{rows}</tbody></table>'

# ── HTML ──
html = f"""<!DOCTYPE html>
<html dir="rtl" lang="he">
<body style="font-family:Arial,sans-serif;background:#f4f6f9;padding:20px;color:#1a202c;margin:0;">
<div style="max-width:760px;margin:auto;">

  <!-- כותרת -->
  <div style="background:#1a365d;padding:22px 28px;color:#fff;border-radius:12px 12px 0 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <td style="vertical-align:middle;">
          <h2 style="margin:0 0 6px;font-size:22px;color:#fff;">&#x1F4CA; דוח שוק יומי — S&amp;P 500</h2>
          <p style="margin:0;opacity:0.8;font-size:13px;color:#fff;">יום המסחר: {date_label} &middot; {total} מניות</p>
        </td>
        <td style="vertical-align:middle;text-align:right;width:130px;">
          <img src="https://nditzik.github.io/indexes-status/logo.png" alt="Logo" style="height:70px;width:auto;border-radius:6px;display:block;margin-bottom:8px;margin-right:0;margin-left:auto;"><br>
          <a href="https://nditzik.github.io/indexes-status/" style="color:#faf089;font-weight:700;font-size:12px;text-decoration:none;border:2px solid #faf089;padding:4px 10px;border-radius:5px;white-space:nowrap;">פתח דשבורד ←</a>
        </td>
      </tr>
    </table>
  </div>

  <!-- נתונים כלליים -->
  <div style="background:#fff;padding:20px 28px;margin-bottom:16px;border-radius:0 0 12px 12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <h3 style="margin:0 0 14px;font-size:16px;color:#1a365d;border-bottom:2px solid #e2e8f0;padding-bottom:8px;">&#x1F4CA; נתוני רוחב שוק</h3>
    {summary_section()}
  </div>

  <!-- מפת חום סקטורים -->
  <div style="background:#fff;padding:20px 28px;margin-bottom:16px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <h3 style="margin:0 0 14px;font-size:16px;color:#1a365d;border-bottom:2px solid #e2e8f0;padding-bottom:8px;">&#x1F525; מפת חום סקטורים — ביצועי היום</h3>
    {sector_heatmap()}
  </div>

  <!-- טבלאות -->
  <div style="background:#fff;padding:20px 28px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    {t_momentum}
    {t_rebound}
  </div>

  <div style="text-align:center;font-size:11px;color:#718096;padding:14px;">
    נוצר אוטומטית &middot; S&amp;P 500 Dashboard &middot; nditzik
  </div>
</div>
</body></html>"""

api_key = os.environ.get("BREVO_API_KEY", "")
payload = json.dumps({
    "sender": {"name": "S&P Dashboard", "email": "nditzik@gmail.com"},
    "to": [
        {"email": "nditzik@gmail.com"},
        {"email": "eddie@teco.org.il"},
        {"email": "yakiryona3@gmail.com"},
        {"email": "ofeknidam@gmail.com"}
    ],
    "subject": f"📊 דוח שוק יומי S&P 500 — {date_label}",
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
