@echo off
cd /d "%~dp0"
git add -A
git commit -m "Update dashboard %date% %time%"
git push
echo.
echo Done! Site updated at https://nditzik.github.io/indexes-status/
pause
