param(
    [int]$Port = 41731,
    [string]$PublicName = "misao.local",
    [string]$Password = "",
    [switch]$ResetPassword,
    [switch]$Background,
    [switch]$Child
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = Join-Path $Root "data"
$ConfigFile = Join-Path $DataDir "remote-console.json"

function New-RemotePassword {
    $bytes = New-Object byte[] 18
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }
    return ([BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
}

if ($PublicName -notmatch '^[A-Za-z0-9.-]+$') {
    throw "PublicName contains unsupported characters: $PublicName"
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$saved = $null
if (Test-Path $ConfigFile) {
    try {
        $saved = Get-Content $ConfigFile -Raw | ConvertFrom-Json
    }
    catch {
        Write-Warning "remote-console.json was invalid and will be recreated."
    }
}

if (-not $Password -and -not $ResetPassword) {
    $Password = [string]$saved.password
}
if (-not $Password) {
    $Password = New-RemotePassword
}
if (-not $PSBoundParameters.ContainsKey("PublicName") -and $saved.publicName) {
    $PublicName = [string]$saved.publicName
}
if (-not $PSBoundParameters.ContainsKey("Port") -and $saved.port) {
    $Port = [int]$saved.port
}

[ordered]@{
    publicName = $PublicName
    port = $Port
    password = $Password
    updatedAt = (Get-Date).ToString("o")
} | ConvertTo-Json | Set-Content -Path $ConfigFile -Encoding UTF8

$url = "http://$PublicName`:$Port"
Write-Host ""
Write-Host "Remote Codex Console"
Write-Host "URL=$url"
Write-Host "Password=$Password"
Write-Host "Fallback=http://<this-PC-LAN-IP>:$Port"
Write-Host ""
Write-Host "Keep this password private. Remote users can operate Codex on this PC."
Write-Host ""

if ($Background -and -not $Child) {
    $stdoutLog = Join-Path $DataDir "remote-console.log"
    $stderrLog = Join-Path $DataDir "remote-console.err.log"
    foreach ($log in @($stdoutLog, $stderrLog)) {
        if (Test-Path $log) {
            Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue
        }
    }

    $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Child"
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList $arguments `
        -WorkingDirectory $Root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog | Out-Null

    $ready = $false
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        Start-Sleep -Milliseconds 200
        try {
            $client = [System.Net.Sockets.TcpClient]::new()
            $connected = $client.ConnectAsync("127.0.0.1", $Port).Wait(200)
            $client.Close()
            if ($connected) {
                $ready = $true
                break
            }
        }
        catch {}
    }

    if (-not $ready) {
        $errorText = if (Test-Path $stderrLog) { (Get-Content $stderrLog -Raw).Trim() } else { "" }
        throw "Remote console did not start. $errorText"
    }

    Write-Host "Remote console is running in the background."
    Write-Host "You can close this window."
    exit 0
}

& (Join-Path $Root "Start-CodexGui.ps1") `
    -Port $Port `
    -NoBrowser `
    -Lan `
    -LanPassword $Password `
    -RemoteConsole `
    -PublicName $PublicName
