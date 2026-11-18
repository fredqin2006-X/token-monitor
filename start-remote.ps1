# TokenTracker + Cloudflare Tunnel launcher
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$env:TOKENTRACKER_APP_SHELL = "windows"
$env:TOKENTRACKER_ALLOWED_ORIGINS = "https://tokenmonitor.fredqin2006.fj.cn"

$tokenFile = Join-Path $env:USERPROFILE ".cloudflared_tokenmonitor_token"
if (-not (Test-Path $tokenFile)) {
  throw "Cloudflare Tunnel token file not found: $tokenFile"
}

$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (-not (Test-Path $cloudflared)) {
  $cloudflared = "cloudflared"
}

$token = (Get-Content $tokenFile -Raw).Trim()
$cfProc = Start-Process -FilePath $cloudflared -ArgumentList @("tunnel", "--protocol", "http2", "run", "--token", $token) -PassThru -WindowStyle Minimized

Write-Host "Cloudflare Tunnel started (PID $($cfProc.Id)) -> https://tokenmonitor.fredqin2006.fj.cn"
Write-Host "Starting TokenTracker dashboard on http://127.0.0.1:7681 ..."
try {
  node bin/tracker.js serve --port 7681 --no-open
} finally {
  if ($cfProc -and -not $cfProc.HasExited) {
    Stop-Process -Id $cfProc.Id -Force -ErrorAction SilentlyContinue
  }
}
