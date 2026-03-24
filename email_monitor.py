"""
Barchart → Gmail → GitHub Pages Auto-Updater
הרצה: python email_monitor.py
"""

import imaplib
import email
import subprocess
import os
import glob
import logging
from datetime import datetime
from email.header import decode_header

# ═══════════ הגדרות ═══════════
GMAIL_USER     = "YOUR_EMAIL@gmail.com"   # ← שנה לכתובת Gmail שלך
GMAIL_APP_PASS = "xxxx xxxx xxxx xxxx"    # ← App Password מ-Google

REPO_DIR       = os.path.dirname(os.path.abspath(__file__))
DATA_DIR       = os.path.join(REPO_DIR, "data")
DATA_FILE      = os.path.join(DATA_DIR, "data.txt")
DATA_CSV       = os.path.join(DATA_DIR, "data.csv")

BARCHART_FROM  = "barchart"               # חיפוש חלקי בשם השולח
SUBJECT_FILTER = "watchlist"              # חיפוש חלקי בנושא המייל

LOG_FILE = os.path.join(REPO_DIR, "update_log.txt")

# ═══════════ לוגינג ═══════════
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler()
    ]
)
log = logging.getLogger()

# ═══════════ Gmail ═══════════
def connect_gmail():
    mail = imaplib.IMAP4_SSL("imap.gmail.com")
    mail.login(GMAIL_USER, GMAIL_APP_PASS)
    mail.select("inbox")
    return mail

def find_barchart_email(mail):
    """מחפש מייל לא נקרא מ-Barchart עם קובץ מצורף"""
    _, ids = mail.search(None, 'UNSEEN FROM "barchart"')
    email_ids = ids[0].split()
    if not email_ids:
        # נסה גם נקראים מהיום
        today = datetime.now().strftime("%d-%b-%Y")
        _, ids = mail.search(None, f'FROM "barchart" ON {today}')
        email_ids = ids[0].split()
    return email_ids

def get_csv_attachment(mail, email_id):
    """מחזיר את תוכן ה-CSV המצורף"""
    _, data = mail.fetch(email_id, "(RFC822)")
    msg = email.message_from_bytes(data[0][1])

    subject = decode_header(msg["Subject"])[0][0]
    if isinstance(subject, bytes):
        subject = subject.decode()
    log.info(f"נמצא מייל: {subject}")

    for part in msg.walk():
        content_type = part.get_content_type()
        filename = part.get_filename()
        if filename and (filename.endswith(".csv") or "watchlist" in filename.lower()):
            log.info(f"קובץ מצורף: {filename}")
            return part.get_payload(decode=True), filename

    return None, None

# ═══════════ קבצים ═══════════
def delete_old_data():
    """מוחק קבצי data ישנים"""
    for f in glob.glob(os.path.join(DATA_DIR, "data.*")):
        os.remove(f)
        log.info(f"נמחק: {os.path.basename(f)}")

def save_data(content, filename):
    """שומר את הקובץ החדש"""
    os.makedirs(DATA_DIR, exist_ok=True)
    delete_old_data()

    # שמור כ-data.txt (לטעינה בדף)
    with open(DATA_FILE, "wb") as f:
        f.write(content)

    # שמור גם כ-data.csv עם שם תאריך לארכיון
    date_str = datetime.now().strftime("%m-%d-%Y")
    archive_name = f"watchlist-sp-500-intraday-{date_str}.csv"
    archive_path = os.path.join(DATA_DIR, archive_name)
    with open(archive_path, "wb") as f:
        f.write(content)

    log.info(f"נשמר: data.txt + {archive_name}")
    return archive_name

# ═══════════ Git Push ═══════════
def git_push(archive_name):
    """דוחף ל-GitHub"""
    try:
        subprocess.run(["git", "-C", REPO_DIR, "add", "-A"],         check=True)
        subprocess.run(["git", "-C", REPO_DIR, "commit", "-m",
                        f"Auto-update {archive_name} {datetime.now().strftime('%Y-%m-%d %H:%M')}"],
                       check=True)
        subprocess.run(["git", "-C", REPO_DIR, "push"],              check=True)
        log.info("Git push הצליח ✓")
        return True
    except subprocess.CalledProcessError as e:
        log.error(f"Git push נכשל: {e}")
        return False

# ═══════════ Main ═══════════
def run():
    log.info("═" * 50)
    log.info("מחפש מייל מ-Barchart...")

    try:
        mail = connect_gmail()
    except Exception as e:
        log.error(f"שגיאת התחברות Gmail: {e}")
        return False

    email_ids = find_barchart_email(mail)
    if not email_ids:
        log.info("לא נמצא מייל חדש מ-Barchart")
        mail.logout()
        return False

    # קח את המייל האחרון
    content, filename = get_csv_attachment(mail, email_ids[-1])
    mail.logout()

    if not content:
        log.error("לא נמצא קובץ CSV במייל")
        return False

    archive_name = save_data(content, filename)
    success = git_push(archive_name)

    if success:
        log.info("✓ הדשבורד עודכן בהצלחה!")
    return success

if __name__ == "__main__":
    run()
