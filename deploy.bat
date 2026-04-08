@echo off
cd /d "%~dp0"

echo.
echo === מעדכן דשבורד... ===
echo.

:: מצא את ה-CSV החדש ביותר בתיקיית data
for /f "delims=" %%f in ('dir /b /od "%~dp0data\watchlist-sp-500-intraday-*.csv" 2^>nul') do set LATEST=%%f

if not defined LATEST (
    echo [שגיאה] לא נמצא קובץ CSV בתיקיית data\
    pause
    exit /b 1
)

echo נמצא: %LATEST%

:: עדכן data.txt
copy /Y "%~dp0data\%LATEST%" "%~dp0data\data.txt" >nul
echo [OK] data.txt עודכן

:: עדכן index.json
python -c "import json,os; f=r'%~dp0data\index.json'; idx=json.load(open(f)) if os.path.exists(f) else []; idx.append('%LATEST%') if '%LATEST%' not in idx else None; idx.sort(); json.dump(idx,open(f,'w'),indent=2); print('[OK] index.json -',len(idx),'קבצים')"

:: Git push
git add data\data.txt data\index.json "data\%LATEST%"
git commit -m "Update %LATEST%"
git push

echo.
echo [OK] הדשבורד עודכן!
echo      https://nditzik.github.io/indexes-status/
echo.
pause
