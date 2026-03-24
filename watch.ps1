$folder = Split-Path -Parent $MyInvocation.MyCommand.Path
$filter = "*.html"

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $folder
$watcher.Filter = $filter
$watcher.NotifyFilter = [System.IO.NotifyFilters]::LastWrite
$watcher.EnableRaisingEvents = $true

Write-Host "Watching for changes in $folder..." -ForegroundColor Cyan

while ($true) {
    $changed = $watcher.WaitForChanged([System.IO.WatcherChangeTypes]::Changed, 5000)
    if (-not $changed.TimedOut) {
        Write-Host "[$((Get-Date).ToString('HH:mm:ss'))] Changed: $($changed.Name) — pushing..." -ForegroundColor Yellow
        Start-Sleep -Seconds 1  # wait for file to finish saving
        Set-Location $folder
        git add -A
        git commit -m "Auto-update $($changed.Name) $((Get-Date).ToString('yyyy-MM-dd HH:mm'))"
        git push
        Write-Host "Done!" -ForegroundColor Green
    }
}
