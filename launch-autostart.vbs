Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""E:\token-monitor\start-dashboard-bg.ps1""", 0, False
shell.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""E:\token-monitor\start-cloudflared-bg.ps1""", 0, False
