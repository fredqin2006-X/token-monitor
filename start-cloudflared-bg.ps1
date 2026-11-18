$ErrorActionPreference = "Continue"

$logDir = Join-Path $env:USERPROFILE ".tokentracker\logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir "cloudflared.log"

$tokenFile = Join-Path $env:USERPROFILE ".cloudflared_tokenmonitor_token"
if (-not (Test-Path $tokenFile)) {
  exit 1
}
$token = (Get-Content $tokenFile -Raw).Trim()

cmd.exe /c """C:\Program Files (x86)\cloudflared\cloudflared.exe"" tunnel --protocol http2 run --token $token >> ""$logFile"" 2>&1"
