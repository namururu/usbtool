param(
    [int]$Port = 41731
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = Join-Path $Root "data"
$CloudflaredExe = Join-Path $Root "tools\cloudflared\cloudflared.exe"
$Installer = Join-Path $Root "Install-Cloudflared.ps1"
$GuiLauncher = Join-Path $Root "Start-CodexGui.ps1"
$StopGui = Join-Path $Root "Stop-CodexGui.ps1"
$TunnelLog = Join-Path $DataDir "public-tunnel.log"
$TunnelErrorLog = Join-Path $DataDir "public-tunnel.err.log"
$GuiLog = Join-Path $DataDir "public-gui.log"
$GuiErrorLog = Join-Path $DataDir "public-gui.err.log"

function New-PublicPassword {
    $bytes = New-Object byte[] 12
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    }
    finally {
        $generator.Dispose()
    }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', 'A').Replace('/', 'B')
}

function Wait-LocalPort {
    param([int]$LocalPort, [int]$Seconds = 30)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $client = [System.Net.Sockets.TcpClient]::new()
            $connected = $client.ConnectAsync("127.0.0.1", $LocalPort).Wait(300)
            $client.Close()
            if ($connected) { return $true }
        }
        catch {}
        Start-Sleep -Milliseconds 300
    }
    return $false
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

if (-not (Test-Path $CloudflaredExe)) {
    Write-Host "Preparing public link for the first time..."
    & $Installer -Quiet
}
if (-not (Test-Path $CloudflaredExe)) {
    throw "cloudflared.exe could not be installed."
}

& $StopGui -Port $Port -Quiet
Remove-Item -LiteralPath $TunnelLog, $TunnelErrorLog, $GuiLog, $GuiErrorLog -Force -ErrorAction SilentlyContinue

$password = New-PublicPassword
$guiArgs = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", $GuiLauncher,
    "-Public", "-NoBrowser",
    "-Port", $Port,
    "-LanPassword", $password
)
$guiProcess = Start-Process powershell.exe -ArgumentList $guiArgs -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $GuiLog -RedirectStandardError $GuiErrorLog

if (-not (Wait-LocalPort -LocalPort $Port)) {
    Stop-Process -Id $guiProcess.Id -Force -ErrorAction SilentlyContinue
    throw "Portable Codex GUI did not start. Check data\public-gui.err.log."
}

$tunnelProcess = $null
try {
    $tunnelArgs = @("tunnel", "--url", "http://127.0.0.1:$Port", "--no-autoupdate", "--loglevel", "info")
    $tunnelProcess = Start-Process $CloudflaredExe -ArgumentList $tunnelArgs -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $TunnelLog -RedirectStandardError $TunnelErrorLog

    $publicUrl = ""
    $deadline = (Get-Date).AddSeconds(40)
    while ((Get-Date) -lt $deadline -and -not $publicUrl) {
        if ($tunnelProcess.HasExited) { break }
        $logText = @(
            Get-Content -LiteralPath $TunnelLog -Raw -ErrorAction SilentlyContinue
            Get-Content -LiteralPath $TunnelErrorLog -Raw -ErrorAction SilentlyContinue
        ) -join "`n"
        $match = [regex]::Match($logText, 'https://[a-z0-9-]+\.trycloudflare\.com')
        if ($match.Success) {
            $publicUrl = $match.Value
        }
        else {
            Start-Sleep -Milliseconds 500
        }
    }

    if (-not $publicUrl) {
        throw "Public URL could not be created. Check data\public-tunnel.err.log."
    }

    Clear-Host
    Write-Host ""
    Write-Host "========================================"
    Write-Host " Portable Codex public link"
    Write-Host "========================================"
    Write-Host ""
    Write-Host "URL      : $publicUrl"
    Write-Host "Password : $password"
    Write-Host ""
    Write-Host "Keep this window open. Press Ctrl+C to stop sharing."
    Write-Host ""

    Wait-Process -Id $tunnelProcess.Id
}
finally {
    if ($tunnelProcess -and -not $tunnelProcess.HasExited) {
        Stop-Process -Id $tunnelProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($guiProcess -and -not $guiProcess.HasExited) {
        Stop-Process -Id $guiProcess.Id -Force -ErrorAction SilentlyContinue
    }
    & $StopGui -Port $Port -Quiet
}
