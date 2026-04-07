@echo off
:: הגדרת Task Scheduler לעדכון אוטומטי של הדשבורד
:: מריץ כל לילה בחצות — ואם המחשב היה כבוי, ירוץ מיד עם ההפעלה

echo.
echo === Barchart Dashboard Auto-Updater ===
echo.

set SCRIPT_DIR=%~dp0
set XML_FILE=%SCRIPT_DIR%task_definition.xml
set TASK_NAME=Barchart Dashboard Updater

:: מחק משימה קיימת אם יש
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

:: צור משימה חדשה מה-XML
schtasks /create /tn "%TASK_NAME%" /xml "%XML_FILE%" /f

if %ERRORLEVEL% EQU 0 (
    echo.
    echo [OK] המשימה נוצרה בהצלחה!
    echo      שם: %TASK_NAME%
    echo      תזמון: כל לילה בחצות
    echo      אם המחשב כבוי — ירוץ מיד בהפעלה הבאה
    echo.
    echo לבדיקה ידנית: python "%SCRIPT_DIR%email_monitor.py"
    echo לוג: %SCRIPT_DIR%update_log.txt
) else (
    echo.
    echo [שגיאה] לא הצליח לצור המשימה.
    echo נסה להריץ כ-Administrator (לחץ ימין על הקובץ → Run as administrator)
)

echo.
pause
