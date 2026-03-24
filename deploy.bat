@echo off
cd /d "%~dp0"

:: Copy latest Barchart CSV from Downloads to data/data.txt + archive
for /f "delims=" %%f in ('dir /b /od "%USERPROFILE%\Downloads\watchlist-sp-500-intraday-*.csv" 2^>nul') do set LATEST=%%f
if defined LATEST (
    copy /Y "%USERPROFILE%\Downloads\%LATEST%" "%~dp0data\data.txt"
    copy /Y "%USERPROFILE%\Downloads\%LATEST%" "%~dp0data\%LATEST%"
    echo Copied: %LATEST%
    :: Update index.json
    python -c "import json,os; f='%~dp0data\\index.json'; idx=json.load(open(f)) if os.path.exists(f) else []; idx.append('%LATEST%') if '%LATEST%' not in idx else None; idx.sort(); json.dump(idx,open(f,'w'),indent=2); print('index.json updated:',len(idx),'files')"
) else (
    echo No Barchart CSV found in Downloads
)

git add -A
git commit -m "Update dashboard %date% %time%"
git push
echo.
echo Done! https://nditzik.github.io/indexes-status/
pause
