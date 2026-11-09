# Starts the photo helper (hidden) at log on via a Startup-folder shortcut, and
# mounts it on this computer's Tailscale HTTPS name at /freezer-photo.
# No admin needed. Re-running is safe.
#     powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pyw = Join-Path (Split-Path (Get-Command python).Source) 'pythonw.exe'
if (-not (Test-Path $pyw)) { $pyw = (Get-Command pythonw).Source }

$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Freezer Photo Helper.lnk'
$sc = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$sc.TargetPath = $pyw
$sc.Arguments = '-I "' + (Join-Path $here 'helper.py') + '"'
$sc.WorkingDirectory = $here
$sc.Description = 'Freezer Scan photo helper (photo -> label suggestions via claude -p)'
$sc.Save()
Write-Host "Startup shortcut: $lnk"

tailscale serve --bg --set-path /freezer-photo http://127.0.0.1:8795 | Out-Null
$name = (tailscale status --json | ConvertFrom-Json).Self.DNSName.TrimEnd('.')
Write-Host "Set the site's SUGGEST_URL to: https://$name/freezer-photo"
