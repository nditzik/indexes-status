"""
check_data_freshness.py — daily "did the data arrive?" watchdog.

Scheduled Tue–Sat 03:30 UTC (~06:30 Israel) — the morning after each US
trading day. If the newest watchlist CSV is behind the most recent
COMPLETED trading day (weekends + US holidays excluded), it emails an
alert — ONLY to the owner, never the daily-report subscriber list.

A delivered alert is a SUCCESS (exit 0); the job only fails on an actual
send error.
"""
import os
import re
import sys
import glob
import json
import urllib.request
import urllib.error
from datetime import date, timedelta

OWNER_EMAIL = 'nditzik@gmail.com'   # alerts go here and ONLY here
WATCHLIST_RE = re.compile(r'watchlist-sp-500-intraday-(\d{2})-(\d{2})-(\d{4})\.csv$')

# Mirror of the US market holidays in v2/forward-tracking.js.
US_HOLIDAYS = {
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
    '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
    '2026-11-26', '2026-12-25',
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26',
    '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06',
    '2027-11-25', '2027-12-24',
}


def is_trading_day(d):
    return d.weekday() < 5 and d.isoformat() not in US_HOLIDAYS


def last_trading_day(before):
    """Most recent trading day strictly before `before`."""
    d = before - timedelta(days=1)
    while not is_trading_day(d):
        d -= timedelta(days=1)
    return d


def latest_watchlist_date():
    latest = None
    for p in glob.glob('data/watchlist-sp-500-intraday-*.csv'):
        m = WATCHLIST_RE.search(p)
        if not m:
            continue
        mm, dd, yyyy = m.groups()
        dt = date(int(yyyy), int(mm), int(dd))
        if latest is None or dt > latest:
            latest = dt
    return latest


def send_alert(expected, latest):
    api_key = os.environ.get('BREVO_API_KEY', '')
    latest_str = latest.strftime('%d/%m/%Y') if latest else '—'
    exp_str = expected.strftime('%d/%m/%Y')
    html = (
        '<div dir="rtl" style="font-family:Arial,sans-serif;text-align:right;direction:rtl;">'
        '<h2 style="color:#dc2626;">⚠ לא התקבל קובץ נתונים</h2>'
        f'<p>ציפינו לקובץ watchlist עבור יום המסחר <b>{exp_str}</b>, אך הוא טרם התקבל.</p>'
        f'<p>הקובץ האחרון שכן התקבל: <b>{latest_str}</b>.</p>'
        '<p style="color:#718096;font-size:12px;">בדיקת טריות אוטומטית · indexes-status</p>'
        '</div>'
    )
    if not api_key:
        print('No BREVO_API_KEY set — would have alerted (dry run).')
        return
    payload = json.dumps({
        'sender': {'name': 'S&P Dashboard', 'email': OWNER_EMAIL},
        'to': [{'email': OWNER_EMAIL}],   # owner only
        'subject': '⚠ indexes-status: לא התקבל קובץ נתונים היום',
        'htmlContent': html,
    }).encode()
    req = urllib.request.Request(
        'https://api.brevo.com/v3/smtp/email', data=payload,
        headers={'api-key': api_key, 'Content-Type': 'application/json',
                 'Accept': 'application/json'})
    with urllib.request.urlopen(req) as r:
        print('Alert sent:', r.read().decode())


def main():
    today = date.today()   # GitHub runner is UTC
    expected = last_trading_day(today)
    latest = latest_watchlist_date()
    print(f'today={today} expected_trading_day={expected} latest_file={latest}')
    if latest is None or latest < expected:
        print('STALE — data for the expected trading day has not arrived. Alerting owner.')
        send_alert(expected, latest)
    else:
        print('Fresh — data is up to date. No alert.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
