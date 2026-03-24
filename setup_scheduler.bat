@echo off
:: הגדרת Task Scheduler להרצת email_monitor.py בסוף כל יום מסחר
:: ימי ב-ו בשעה 23:30 (= 16:30 ET)

set SCRIPT_DIR=%~dp0
set PYTHON=python
set SCRIPT=%SCRIPT_DIR%email_monitor.py

schtasks /create /tn "Barchart Dashboard Updater" ^
  /tr "\"%PYTHON%\" \"%SCRIPT%\"" ^
  /sc WEEKLY ^
  /d MON,TUE,WED,THU,FRI ^
  /st 23:30 ^
  /f

echo.
echo Task Scheduler הוגדר בהצלחה!
echo המשימה תרוץ כל יום ב-ו בשעה 23:30
echo.
echo לבדיקה ידנית הרץ: python "%SCRIPT%"
pause
