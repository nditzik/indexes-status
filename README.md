# S&P 500 Market Dashboard

A live, single-page dashboard for tracking S&P 500 market breadth, sector performance, momentum stocks, and rebound candidates — with daily email reports sent automatically on every data update.

**Live dashboard:** [nditzik.github.io/indexes-status](https://nditzik.github.io/indexes-status/)

---

## Features

- **Market breadth indicators** — Health Score, % above 200/150/50/20D MA, Golden Cross count, RSI distribution, A/D ratio, NH/NL ratio
- **Sector heatmap** — % of stocks above 200D MA per sector + average daily change
- **Top momentum stocks** — scored by MA position, RSI, volume, 52W distance
- **Rebound candidates** — weak RSI + volume spike + at least 1 MA support
- **AI market summary** — daily Hebrew analysis powered by Groq (llama-3.3-70b), runs in the browser
- **History tracking** — multi-day trend charts and health score over time
- **Automatic daily email** — sent to subscribers on every CSV push via GitHub Actions + Brevo

## How it works

1. Export the S&P 500 watchlist from Barchart as a CSV file named `watchlist-sp-500-intraday-YYYY-MM-DD.csv`
2. Place it in the `data/` folder and push to GitHub
3. A GitHub Action automatically:
   - Updates `data/data.txt` and `data/index.json`
   - Sends a formatted HTML email report to all subscribers
4. The dashboard at GitHub Pages picks up the new data on next load

## Setup

### GitHub Secrets required
| Secret | Description |
|--------|-------------|
| `BREVO_API_KEY` | Brevo (Sendinblue) API key for sending emails |

### AI summary (optional)
- Get a free API key from [console.groq.com](https://console.groq.com)
- Enter it in the dashboard via the key icon (stored in localStorage)

### Manual update (Windows)
Run `deploy.bat` — finds the latest CSV, updates data files, and pushes to GitHub.

## Tech stack

- Vanilla HTML/CSS/JS, Chart.js, glassmorphism design
- GitHub Actions for CI/CD automation
- Python (stdlib only) for email generation
- Brevo REST API for email delivery
- Groq API (browser-side) for AI summaries

---

---

# דשבורד מניות S&P 500

דשבורד חי לניתוח רוחב שוק ה-S&P 500 — מעקב אחרי מניות מעל ממוצעים נעים, סקטורים, מומנטום ומועמדות לריבאונד, עם דוח מייל יומי אוטומטי.

**דשבורד חי:** [nditzik.github.io/indexes-status](https://nditzik.github.io/indexes-status/)

---

## יכולות

- **רוחב שוק** — ציון בריאות, % מעל 200/150/50/20D MA, Golden Cross, RSI, יחס עולות/יורדות, NH/NL
- **מפת חום סקטורים** — % מניות מעל 200D MA לפי סקטור + שינוי יומי ממוצע
- **מניות מומנטום** — Top 15 לפי ציון משוקלל (MA + RSI + נפח + 52W)
- **מועמדות לריבאונד** — RSI חלש + נפח גבוה + תמיכת MA אחת לפחות
- **סיכום AI** — ניתוח יומי בעברית מבוסס Groq (llama-3.3-70b), רץ בדפדפן
- **היסטוריה** — גרפי מגמה וטבלת ציון בריאות לאורך זמן
- **מייל יומי אוטומטי** — נשלח בכל עדכון CSV דרך GitHub Actions + Brevo

## איך זה עובד

1. ייצא רשימת מעקב S&P 500 מ-Barchart כקובץ CSV בשם `watchlist-sp-500-intraday-YYYY-MM-DD.csv`
2. הכנס אותו לתיקיית `data/` ודחוף ל-GitHub
3. GitHub Action מבצע אוטומטית:
   - עדכון `data/data.txt` ו-`data/index.json`
   - שליחת דוח HTML מפורמט לכל הנמענים
4. הדשבורד ב-GitHub Pages טוען את הנתונים החדשים בטעינה הבאה

## הגדרה

### GitHub Secrets נדרשים
| Secret | תיאור |
|--------|-------|
| `BREVO_API_KEY` | מפתח API של Brevo לשליחת מיילים |

### סיכום AI (אופציונלי)
- קבל מפתח API חינמי מ-[console.groq.com](https://console.groq.com)
- הזן אותו בדשבורד דרך אייקון המפתח (נשמר ב-localStorage)

### עדכון ידני (Windows)
הרץ את `deploy.bat` — מוצא את ה-CSV האחרון, מעדכן קבצי נתונים ודוחף ל-GitHub.

## טכנולוגיות

- HTML/CSS/JS טהור, Chart.js, עיצוב glassmorphism
- GitHub Actions לאוטומציה
- Python (ספריות סטנדרטיות בלבד) לבניית האימייל
- Brevo REST API לשליחת מיילים
- Groq API (בדפדפן) לסיכומי AI
