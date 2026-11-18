$ErrorActionPreference = "Continue"
Set-Location "E:\token-monitor"

$logDir = Join-Path $env:USERPROFILE ".tokentracker\logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir "dashboard.log"

$env:TOKENTRACKER_APP_SHELL = "windows"
$env:TOKENTRACKER_ALLOWED_ORIGINS = "https://tokenmonitor.fredqin2006.fj.cn"

cmd.exe /c """C:\Program Files\nodejs\node.exe"" ""E:\token-monitor\bin\tracker.js"" serve --port 7681 --no-open --no-sync >> ""$logFile"" 2>&1"
