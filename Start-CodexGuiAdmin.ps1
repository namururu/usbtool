param(
    [int]$Port = 41731,
    [switch]$NoBrowser,
    [switch]$Lan,
    [string]$LanPassword = "",
    [string]$LanToken = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
    $quotedScript = '"' + $PSCommandPath + '"'
    $argsList = "-NoProfile -ExecutionPolicy Bypass -File $quotedScript -Port $Port"
    if ($NoBrowser) {
        $argsList += " -NoBrowser"
    }
    if ($Lan) {
        $argsList += " -Lan"
    }
    if ($LanPassword) {
        $argsList += " -LanPassword `"$LanPassword`""
    }
    if ($LanToken) {
        $argsList += " -LanToken `"$LanToken`""
    }
    Start-Process -FilePath "powershell.exe" -Verb RunAs -WorkingDirectory $Root -ArgumentList $argsList | Out-Null
    exit 0
}

Set-Location $Root

$updateScript = Join-Path $Root "Update-Self.ps1"
if (Test-Path $updateScript) {
    & $updateScript -Quiet
}

$stopScript = Join-Path $Root "Stop-CodexGui.ps1"
if (Test-Path $stopScript) {
    & $stopScript -Quiet
}

$codexUpdateScript = Join-Path $Root "Update-Codex.ps1"
if (Test-Path $codexUpdateScript) {
    & $codexUpdateScript -Auto -Quiet
}

& (Join-Path $Root "Start-CodexGui.ps1") -Port $Port -NoBrowser:$NoBrowser -Lan:$Lan -LanPassword $LanPassword -LanToken $LanToken
