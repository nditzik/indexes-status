@echo off
cd /d "%~dp0"

:: Copy latest CSV from Downloads (update filename pattern if needed)
for /f "delims=" %%f in ('dir /b /od "%USERPROFILE%\Downloads\watchlist-sp-500-intraday-*.csv" 2^>nul') do set LATEST=%%f
if defined LATEST (
    copy /Y "%USERPROFILE%\Downloads\%LATEST%" "%~dp0data.csv"
    echo Copied: %LATEST% -> data.csv
) else (
    echo No Barchart CSV found in Downloads - skipping copy
)

git add -A
git commit -m "Update dashboard %date% %time%"
git push
echo.
echo Done! https://nditzik.github.io/indexes-status/
pause
