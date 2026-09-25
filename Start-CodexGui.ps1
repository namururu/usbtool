param(
    [int]$Port = 41731,
    [switch]$NoBrowser,
    [switch]$Lan,
    [string]$LanPassword = "",
    [string]$LanToken = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeDir = Join-Path $Root "tools\node"
$PythonDir = Join-Path $Root "tools\python"
$NpmPrefix = Join-Path $Root "tools\npm-global"
$NpmCache = Join-Path $Root "tools\npm-cache"
$CodexHome = Join-Path $Root "data\codex-home"
$WorkspaceDir = Join-Path $Root "workspaces"
$GuiServer = Join-Path $Root "gui\server.js"

function New-SharePassword {
    return (Get-Random -Minimum 100000 -Maximum 999999).ToString()
}

function Get-LanAddress {
    $addresses = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
        Where-Object {
            $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
            -not $_.IPAddressToString.StartsWith("127.")
        } |
        Select-Object -ExpandProperty IPAddressToString
    return $addresses | Select-Object -First 1
}

function Add-PathFirst {
    param([string]$PathToAdd)
    $parts = $env:Path -split ';' | Where-Object { $_ -and ($_ -ne $PathToAdd) }
    $env:Path = @($PathToAdd) + $parts -join ';'
}

New-Item -ItemType Directory -Force -Path $CodexHome, $WorkspaceDir, $NpmCache | Out-Null

$StatusLineScript = Join-Path $Root "Set-CodexStatusLine.ps1"
if (Test-Path $StatusLineScript) {
    & $StatusLineScript -Quiet
}

function Get-PortableCodexExe {
    $vendorRoot = Join-Path $Root "tools\codex\vendor"
    if (-not (Test-Path $vendorRoot)) {
        return ""
    }
    $archText = @($env:PROCESSOR_ARCHITEW6432, $env:PROCESSOR_ARCHITECTURE) -join " "
    $preferred = if ($archText -match "ARM64") {
        @("aarch64-pc-windows-msvc", "x86_64-pc-windows-msvc")
    }
    else {
        @("x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc")
    }
    foreach ($triple in $preferred) {
        $candidate = Join-Path $vendorRoot "$triple\bin\codex.exe"
        if (Test-Path $candidate) {
            return $candidate
        }
    }
    $fallback = Get-ChildItem -Path $vendorRoot -Recurse -Filter "codex.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($fallback) {
        return $fallback.FullName
    }
    return ""
}

Add-PathFirst $NodeDir
Add-PathFirst $NpmPrefix
if (Test-Path (Join-Path $PythonDir "python.exe")) {
    Add-PathFirst $PythonDir
    Add-PathFirst (Join-Path $PythonDir "Scripts")
    $env:PYTHONHOME = $PythonDir
}

$env:npm_config_prefix = $NpmPrefix
$env:npm_config_cache = $NpmCache
$env:CODEX_HOME = $CodexHome
$env:PORTABLE_CODEX_ROOT = $Root

$codexCmd = Join-Path $NpmPrefix "codex.cmd"
$PortableCodexExe = Get-PortableCodexExe
if (-not (Test-Path $codexCmd) -and -not (Test-Path $PortableCodexExe)) {
    Write-Host "Codex CLI is not installed in this portable kit yet."
    Write-Host "Run:"
    Write-Host "  .\Install-UsbCodex.ps1"
    exit 1
}

if (-not (Test-Path $GuiServer)) {
    throw "GUI server is missing: $GuiServer"
}

$BindHost = if ($Lan) { "0.0.0.0" } else { "127.0.0.1" }
if ($LanToken -and -not $LanPassword) {
    $LanPassword = $LanToken
}
if ($Lan -and -not $LanPassword) {
    $LanPassword = New-SharePassword
}
$LocalUrl = "http://127.0.0.1:$Port"
$LanAddress = if ($Lan) { Get-LanAddress } else { "" }
$LanUrl = if ($LanAddress) { "http://$LanAddress`:$Port" } else { "" }
try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $connected = $client.ConnectAsync("127.0.0.1", $Port).Wait(400)
    $client.Close()
    if ($connected) {
        Write-Host "Portable Codex GUI already appears to be running."
        Write-Host "Opening $LocalUrl"
        if (-not $NoBrowser) {
            Start-Process $LocalUrl | Out-Null
        }
        exit 0
    }
}
catch {
    # If the quick port probe fails, continue and let Node report any real startup error.
}

Write-Host "Starting Portable Codex GUI..."
Write-Host "URL=$LocalUrl"
if ($Lan) {
    Write-Host ""
    Write-Host "LAN sharing is enabled."
    if ($LanUrl) {
        Write-Host "Share URL=$LanUrl"
        Write-Host "Password=$LanPassword"
    }
    else {
        Write-Host "Share URL: could not detect LAN IP. Run ipconfig and use http://<IPv4>:$Port"
        Write-Host "Password=$LanPassword"
    }
    Write-Host "Only share this URL with trusted people on this LAN."
    Write-Host ""
}
Write-Host "CODEX_HOME=$CodexHome"

if (-not $NoBrowser) {
    Start-Process $LocalUrl | Out-Null
}

$serverArgs = @($GuiServer, "--port", $Port, "--host", $BindHost)
if ($Lan) {
    $serverArgs += @("--lan-token", $LanPassword)
}
& (Join-Path $NodeDir "node.exe") @serverArgs
