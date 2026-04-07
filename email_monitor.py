"""
Barchart → Gmail → Dashboard Auto-Updater
=========================================
בודק אם הגיע מייל מ-Barchart עם נתוני יום המסחר האחרון.
אם הנתונים כבר קיימים — לא עושה כלום.
אם חסרים — מוריד, שומר, ועושה git push.

הרצה: python email_monitor.py
תזמון: Task Scheduler — כל יום בחצות (כולל "הפעל אם פוספס")
"""

import imaplib
import email
import subprocess
import os
import json
import logging
import re
from datetime import datetime, timedelta
from email.header import decode_header

# ═══════════════════════════════════════════
#  הגדרות — שנה רק כאן
# ═══════════════════════════════════════════
GMAIL_USER     = "nditzik@gmail.com"
GMAIL_APP_PASS = "xxxx xxxx xxxx xxxx"    # ← הכנס App Password מ-Google (ראה README)

REPO_DIR   = os.path.dirname(os.path.abspath(__file__))
DATA_DIR   = os.path.join(REPO_DIR, "data")
DATA_FILE  = os.path.join(DATA_DIR, "data.txt")
INDEX_FILE = os.path.join(DATA_DIR, "index.json")
LOG_FILE   = os.path.join(REPO_DIR, "update_log.txt")

# ═══════════════════════════════════════════
#  לוגינג
# ═══════════════════════════════════════════
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler()
    ]
)
log = logging.getLogger()


# ═══════════════════════════════════════════
#  לוגיקת ימי מסחר
# ═══════════════════════════════════════════
US_MARKET_HOLIDAYS_2026 = {
    # תאריכים בפורמט (month, day)
    (1, 1),   # New Year's Day
    (1, 19),  # MLK Day
    (2, 16),  # Presidents Day
    (4, 3),   # Good Friday
    (5, 25),  # Memorial Day
    (7, 3),   # Independence Day (observed)
    (9, 7),   # Labor Day
    (11, 26), # Thanksgiving
    (12, 25), # Christmas
}

def is_trading_day(d):
    """בודק אם תאריך נתון הוא יום מסחר בארה"ב"""
    if d.weekday() >= 5:          # שבת (5) או ראשון (6)
        return False
    if (d.month, d.day) in US_MARKET_HOLIDAYS_2026:
        return False
    return True

def last_trading_day():
    """מחזיר את יום המסחר האחרון שהסתיים (לא כולל היום)"""
    d = datetime.now().date() - timedelta(days=1)
    while not is_trading_day(d):
        d -= timedelta(days=1)
    return d

def expected_archive_name(d):
    """שם הקובץ הצפוי לפי תאריך"""
    return f"watchlist-sp-500-intraday-{d.strftime('%m-%d-%Y')}.csv"

def already_have_data(d):
    """בודק אם כבר יש לנו את נתוני התאריך הזה"""
    path = os.path.join(DATA_DIR, expected_archive_name(d))
    if os.path.exists(path):
        log.info(f"נתוני {d} כבר קיימים — אין צורך בעדכון.")
        return True
    return False


# ═══════════════════════════════════════════
#  Gmail IMAP
# ═══════════════════════════════════════════
def connect_gmail():
    mail = imaplib.IMAP4_SSL("imap.gmail.com")
    mail.login(GMAIL_USER, GMAIL_APP_PASS)
    mail.select("inbox")
    return mail

def find_barchart_emails(mail, trading_day):
    """
    מחפש מיילים מ-Barchart עם CSV מצורף.
    מחפש גם ב-2 ימים אחורה (כי מייל של יום ו' מגיע אחרי חצות של שבת).
    """
    all_ids = []
    for offset in range(3):
        d = trading_day - timedelta(days=offset)
        imap_date = d.strftime("%d-%b-%Y")
        _, ids = mail.search(None, f'FROM "barchart.com" SINCE {imap_date}')
        found = ids[0].split()
        all_ids.extend(found)

    # הסר כפילויות, שמור סדר
    seen = set()
    unique = []
    for eid in reversed(all_ids):
        if eid not in seen:
            seen.add(eid)
            unique.append(eid)
    return unique

def extract_date_from_filename(filename):
    """
    חולץ תאריך מ-filename של Barchart.
    דוגמה: watchlist-sandp-500-04-03-2026.csv → date(2026, 4, 3)
    """
    m = re.search(r'(\d{2})-(\d{2})-(\d{4})', filename)
    if m:
        month, day, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            return datetime(year, month, day).date()
        except ValueError:
            pass
    return None

def get_csv_attachment(mail, email_id, expected_day):
    """
    פותח מייל ומחפש CSV מצורף שתואם את יום המסחר הצפוי.
    מחזיר: (bytes_content, archive_filename) או (None, None)
    """
    _, data = mail.fetch(email_id, "(RFC822)")
    msg = email.message_from_bytes(data[0][1])

    subject_raw = decode_header(msg["Subject"])[0][0]
    subject = subject_raw.decode() if isinstance(subject_raw, bytes) else (subject_raw or "")
    log.info(f"בודק מייל: {subject}")

    for part in msg.walk():
        filename = part.get_filename()
        if not filename:
            continue
        if not (filename.endswith(".csv") or "watchlist" in filename.lower()):
            continue

        file_date = extract_date_from_filename(filename)
        if file_date is None:
            log.warning(f"לא הצלחתי לחלץ תאריך מ-{filename}, מדלג")
            continue

        if file_date != expected_day:
            log.info(f"CSV מ-{file_date} — לא תואם ליום הצפוי {expected_day}, מדלג")
            continue

        log.info(f"נמצא CSV תואם: {filename} (תאריך: {file_date})")
        return part.get_payload(decode=True), expected_archive_name(file_date)

    return None, None


# ═══════════════════════════════════════════
#  שמירת קבצים
# ═══════════════════════════════════════════
def save_and_update(content, archive_name):
    """שומר data.txt + קובץ ארכיון, ומעדכן index.json"""
    os.makedirs(DATA_DIR, exist_ok=True)
    archive_path = os.path.join(DATA_DIR, archive_name)

    with open(archive_path, "wb") as f:
        f.write(content)
    with open(DATA_FILE, "wb") as f:
        f.write(content)

    # עדכון index.json
    index = []
    if os.path.exists(INDEX_FILE):
        with open(INDEX_FILE, "r", encoding="utf-8") as f:
            index = json.load(f)
    if archive_name not in index:
        index.append(archive_name)
        index.sort()
    with open(INDEX_FILE, "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2)

    log.info(f"נשמר: {archive_name} | index.json = {len(index)} קבצים")


# ═══════════════════════════════════════════
#  Git Push
# ═══════════════════════════════════════════
def git_push(archive_name):
    date_str = datetime.now().strftime("%Y-%m-%d %H:%M")
    try:
        subprocess.run(["git", "-C", REPO_DIR, "add",
                        os.path.join("data", archive_name),
                        os.path.join("data", "data.txt"),
                        os.path.join("data", "index.json")],
                       check=True)
        subprocess.run(["git", "-C", REPO_DIR, "commit", "-m",
                        f"Auto-update {archive_name} [{date_str}]"],
                       check=True)
        subprocess.run(["git", "-C", REPO_DIR, "push"], check=True)
        log.info("Git push הצליח ✓")
        return True
    except subprocess.CalledProcessError as e:
        log.error(f"Git push נכשל: {e}")
        return False


# ═══════════════════════════════════════════
#  Main
# ═══════════════════════════════════════════
def run():
    log.info("═" * 55)
    log.info(f"הרצה: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    trading_day = last_trading_day()
    log.info(f"יום מסחר צפוי: {trading_day}")

    # בדיקה: האם כבר יש נתונים?
    if already_have_data(trading_day):
        return True

    # התחברות Gmail
    try:
        mail = connect_gmail()
    except Exception as e:
        log.error(f"שגיאת התחברות Gmail: {e}")
        log.error("ודא ש-App Password נכון ו-IMAP מופעל בהגדרות Gmail")
        return False

    # חיפוש מייל
    email_ids = find_barchart_emails(mail, trading_day)
    if not email_ids:
        log.warning("לא נמצא מייל מ-Barchart — ייתכן שטרם הגיע")
        mail.logout()
        return False

    log.info(f"נמצאו {len(email_ids)} מיילים מ-Barchart, מחפש CSV תואם...")

    content, archive_name = None, None
    for eid in email_ids:
        content, archive_name = get_csv_attachment(mail, eid, trading_day)
        if content:
            break

    mail.logout()

    if not content:
        log.warning(f"לא נמצא CSV עם תאריך {trading_day} באף מייל")
        return False

    save_and_update(content, archive_name)
    success = git_push(archive_name)

    if success:
        log.info(f"✓ הדשבורד עודכן בהצלחה! ({archive_name})")
    return success


if __name__ == "__main__":
    run()
