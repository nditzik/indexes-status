import csv, json, os, urllib.request, glob, io

# קרא את ה-CSV
with open('data/data.txt', encoding='utf-8') as f:
    content = f.read()
print(f"data.txt size: {len(content)} chars")
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
        latest = float(row.get('Latest', 0) or 0)
        ma200  = float(row.get('200D MA', 0) or 0)
        ma50   = float(row.get('50D MA', 0) or 0)
        rvol   = float(row.get('20D RelVol', 0) or 0)
        chg    = row.get('%Change','').strip()
        rsi    = row.get('RSI Rank','').strip()
        w52    = float(row.get('52W %/High', 0) or 0)
    except:
        continue
    if latest <= 0:
        continue
    dist200 = (latest/ma200-1)*100 if ma200 > 0 else None
    stocks.append({
        'sym': sym, 'name': row.get('Name','').strip('"'),
        'latest': latest, 'ma200': ma200, 'ma50': ma50,
        'rvol': rvol, 'chg': chg, 'rsi': rsi,
        'w52': w52, 'dist200': dist200
    })

print(f"Valid stocks: {len(stocks)}")

# תאריך
files = sorted(glob.glob('data/watchlist-sp-500-intraday-*.csv'))
date_label = files[-1].replace('data/watchlist-sp-500-intraday-','').replace('.csv','') if files else ''

# סיכום שוק
total = len(stocks)
above200  = sum(1 for s in stocks if s['dist200'] is not None and s['dist200'] > 0)
golden    = sum(1 for s in stocks if s['ma50'] > 0 and s['ma200'] > 0 and s['ma50'] > s['ma200'])
advancing = sum(1 for s in stocks if '+' in s['chg'])
declining = sum(1 for s in stocks if s['chg'].startswith('-'))
nh = sum(1 for s in stocks if s['w52'] >= -5)
nl = sum(1 for s in stocks if s['w52'] <= -30)
ratio  = f"{nh/nl:.2f}" if nl > 0 else "inf"
health = round((above200/total*100)*0.30 + (golden/total*100)*0.25 + 0.25*50 + (nh/total*100)*0.20) if total else 0

def summary_table():
    p200  = round(above200/total*100,1) if total else 0
    pgold = round(golden/total*100,1) if total else 0
    items = [
        ("ציון בריאות שוק",  f"{health}/100",                        "#3182ce"),
        ("מעל 200D MA",      f"{p200}% ({above200}/{total})",         "#38a169" if p200 > 50 else "#e53e3e"),
        ("Golden Cross",     f"{pgold}%",                             "#d69e2e"),
        ("עולות / יורדות",   f"{advancing} / {declining}",            "#38a169" if advancing > declining else "#e53e3e"),
        ("NH / NL יחס",      f"{nh} / {nl} = {ratio}",               "#38a169" if nl == 0 or (nl > 0 and nh/nl >= 2) else "#e53e3e"),
    ]
    rows = ''.join(
        f'<tr><td style="padding:8px 14px;font-weight:600;color:#4a5568;">{k}</td>'
        f'<td style="padding:8px 14px;font-weight:700;color:{c};">{v}</td></tr>'
        for k,v,c in items
    )
    return f'<table style="width:100%;border-collapse:collapse;font-size:14px;"><tbody>{rows}</tbody></table>'

def make_table(data, cols, headers, title, color):
    if not data:
        return f'<div style="margin-bottom:28px;"><h3 style="margin:0 0 10px;font-size:16px;color:#fff;background:{color};padding:10px 14px;border-radius:8px;">{title}</h3><p style="color:#a0aec0;font-size:13px;padding:10px;">אין נתונים</p></div>'
    th = ''.join(
        f'<th style="padding:9px 10px;text-align:{"right" if i<=1 else "center"};">{h}</th>'
        for i,h in enumerate(headers)
    )
    tbody = ''
    for i, s in enumerate(data[:20]):
        bg = '#f7fafc' if i%2==0 else '#fff'
        tds = ''
        for j, c in enumerate(cols):
            val = s.get(c,'')
            align = 'right' if j<=1 else 'center'
            fw = 'font-weight:700;color:#2b6cb0;' if j==0 else ''
            if c == 'chg':
                col = '#276749' if '+' in str(val) else '#c53030'
                tds += f'<td style="padding:7px 10px;text-align:{align};color:{col};font-weight:600;">{val}</td>'
            elif c == 'dist200':
                sign = '+' if val >= 0 else ''
                col2 = '#276749' if val >= 0 else '#c53030'
                tds += f'<td style="padding:7px 10px;text-align:{align};color:{col2};font-weight:600;">{sign}{val:.2f}%</td>'
            elif c == 'rvol':
                col2 = '#276749' if float(val or 0) > 1.2 else '#4a5568'
                tds += f'<td style="padding:7px 10px;text-align:{align};color:{col2};">{float(val):.2f}</td>'
            else:
                tds += f'<td style="padding:7px 10px;text-align:{align};{fw}">{val}</td>'
        tbody += f'<tr style="background:{bg};">{tds}</tr>'
    return (
        f'<div style="margin-bottom:28px;">'
        f'<h3 style="margin:0 0 0;font-size:15px;color:#fff;background:{color};padding:10px 14px;border-radius:8px 8px 0 0;">{title}</h3>'
        f'<table style="width:100%;border-collapse:collapse;font-size:13px;">'
        f'<thead><tr style="background:#2d3748;color:#fff;">{th}</tr></thead>'
        f'<tbody>{tbody}</tbody>'
        f'</table></div>'
    )

# 1. מעל 200D MA (0-5%)
above_list = sorted([s for s in stocks if s['dist200'] is not None and 0 <= s['dist200'] <= 5], key=lambda x: x['dist200'])
t1 = make_table(above_list, ['sym','name','latest','ma200','dist200','chg'], ['סימול','שם','מחיר','200D MA','מרחק','שינוי'],
    f"📈 מניות שחצו מעל 200D MA — {len(above_list)} מניות", "#276749")

# 2. ירדו מתחת ל-200D MA (0 עד -5%)
below_list = sorted([s for s in stocks if s['dist200'] is not None and -5 <= s['dist200'] < 0], key=lambda x: x['dist200'], reverse=True)
t2 = make_table(below_list, ['sym','name','latest','ma200','dist200','chg'], ['סימול','שם','מחיר','200D MA','מרחק','שינוי'],
    f"⚠️ מניות שירדו מתחת ל-200D MA — {len(below_list)} מניות", "#c53030")

# 3. Top 10 מומנטום
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

top10 = sorted(stocks, key=momentum_score, reverse=True)[:10]
for s in top10: s['mscore'] = momentum_score(s)
t3 = make_table(top10, ['sym','name','mscore','chg','rvol','rsi'], ['סימול','שם','ציון','שינוי','RVOL','RSI'],
    "🏆 Top 10 מומנטום — המניות החזקות ביותר", "#2b6cb0")

# 4. RVOL גבוה עם עלייה
rvol_list = sorted([s for s in stocks if s['rvol'] > 1.5 and '+' in s['chg']], key=lambda x: x['rvol'], reverse=True)[:15]
t4 = make_table(rvol_list, ['sym','name','chg','rvol','rsi'], ['סימול','שם','שינוי','RVOL','RSI'],
    f"🔥 נפח חריג (RVOL>1.5) עם עלייה — {len(rvol_list)} מניות", "#744210")

html = f"""<html dir="rtl" lang="he"><body style="font-family:Arial,sans-serif;background:#f4f6f9;padding:20px;color:#1a202c;">
<div style="max-width:760px;margin:auto;">
  <div style="background:#1a365d;padding:22px 28px;color:#fff;border-radius:12px 12px 0 0;margin-bottom:2px;">
    <h2 style="margin:0 0 4px;font-size:22px;">&#x1F4CA; דוח שוק יומי — S&P 500</h2>
    <p style="margin:0;opacity:0.8;font-size:13px;">יום המסחר: {date_label} · {total} מניות</p>
  </div>
  <div style="background:#fff;padding:20px 28px;margin-bottom:16px;border-radius:0 0 8px 8px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <h3 style="margin:0 0 12px;font-size:15px;color:#2d3748;">סיכום מצב שוק</h3>
    {summary_table()}
  </div>
  <div style="background:#fff;padding:20px 28px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    {t1}{t2}{t3}{t4}
  </div>
  <div style="text-align:center;font-size:11px;color:#718096;padding:14px;">
    נוצר אוטומטית · S&amp;P 500 Dashboard · nditzik
  </div>
</div></body></html>"""

api_key = os.environ.get("BREVO_API_KEY", "")
payload = json.dumps({
    "sender": {"name": "S&P Dashboard", "email": "nditzik@gmail.com"},
    "to": [
        {"email": "nditzik@gmail.com"},
        {"email": "eddie@teco.org.il"},
        {"email": "yakiryona3@gmail.com"}
    ],
    "subject": f"דוח שוק יומי S&P 500 — {date_label}",
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
