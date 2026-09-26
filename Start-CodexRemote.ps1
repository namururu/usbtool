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
$StartupFile = Join-Path $DataDir "remote-startup.json"

function Write-StartupStatus {
    param([string]$Status, [string]$Message)
    [ordered]@{
        status = $Status
        message = $Message
        port = $Port
        checkedAt = (Get-Date).ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath $StartupFile -Encoding UTF8
}

trap {
    $message = $_.Exception.Message
    if ($Password) { $message = $message.Replace($Password, "[redacted]") }
    if (-not $Child -and (Test-Path $DataDir)) {
        Write-StartupStatus -Status "failed" -Message $message
    }
    Write-Host "Remote console startup FAILED: $message" -ForegroundColor Red
    Write-Host "See data\remote-startup.json and data\remote-console.err.log."
    exit 1
}

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

if (-not $Child) {
    [ordered]@{
        publicName = $PublicName
        port = $Port
        password = $Password
        updatedAt = (Get-Date).ToString("o")
    } | ConvertTo-Json | Set-Content -Path $ConfigFile -Encoding UTF8
}

$url = "http://$PublicName`:$Port"
if (-not $Child) {
    Write-Host ""
    Write-Host "Remote Codex Console"
    Write-Host "URL=$url"
    Write-Host "Password=$Password"
    Write-Host "Local=http://127.0.0.1:$Port"
    try {
        [Net.Dns]::GetHostAddresses([Net.Dns]::GetHostName()) |
            Where-Object { $_.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork -and -not [Net.IPAddress]::IsLoopback($_) } |
            ForEach-Object { Write-Host "LAN=http://$($_.IPAddressToString):$Port" }
    } catch {}
    Write-Host ""
    Write-Host "Keep this password private. Remote users can operate Codex on this PC."
    Write-Host ""
}

if ($Background -and -not $Child) {
    Write-StartupStatus -Status "starting" -Message "Waiting for the remote console."
    Write-Host "Starting background server..."
    $stdoutLog = Join-Path $DataDir "remote-console.log"
    $stderrLog = Join-Path $DataDir "remote-console.err.log"
    foreach ($log in @($stdoutLog, $stderrLog)) {
        if (Test-Path $log) {
            Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue
        }
    }

    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Child"
    $serverProcess = Start-Process -FilePath "powershell.exe" `
        -ArgumentList $arguments `
        -WorkingDirectory $Root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog -PassThru

    $ready = $false
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 200
        $serverProcess.Refresh()
        if ($serverProcess.HasExited) { break }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/status?light=1" `
                -Headers @{ "x-portable-codex-token" = $Password } -TimeoutSec 1
            if ($health.remoteConsole -eq $true -and $health.root -eq $Root -and $health.publicName -eq $PublicName) {
                $ready = $true
                break
            }
        }
        catch {}
    }

    if (-not $ready) {
        $errorText = if (Test-Path $stderrLog) { [string](Get-Content $stderrLog -Raw) } else { "" }
        if (-not ([string]$errorText).Trim() -and (Test-Path $stdoutLog)) {
            $errorText = (Get-Content $stdoutLog -Tail 15) -join "`n"
        }
        if (-not $errorText) { $errorText = "No matching remote console responded within 30 seconds." }
        if (-not $serverProcess.HasExited) {
            & taskkill.exe /PID $serverProcess.Id /T /F | Out-Null
        }
        throw "Remote console did not start. $errorText"
    }

    Write-StartupStatus -Status "running" -Message "Remote console HTTP response verified."
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
