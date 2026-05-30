param(
    [int]$Port = 41731,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeDir = Join-Path $Root "tools\node"
$PythonDir = Join-Path $Root "tools\python"
$NpmPrefix = Join-Path $Root "tools\npm-global"
$NpmCache = Join-Path $Root "tools\npm-cache"
$PortableCodexExe = Join-Path $Root "tools\codex\vendor\x86_64-pc-windows-msvc\bin\codex.exe"
$CodexHome = Join-Path $Root "data\codex-home"
$WorkspaceDir = Join-Path $Root "workspaces"
$GuiServer = Join-Path $Root "gui\server.js"

function Add-PathFirst {
    param([string]$PathToAdd)
    $parts = $env:Path -split ';' | Where-Object { $_ -and ($_ -ne $PathToAdd) }
    $env:Path = @($PathToAdd) + $parts -join ';'
}

New-Item -ItemType Directory -Force -Path $CodexHome, $WorkspaceDir, $NpmCache | Out-Null

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
if (-not (Test-Path $codexCmd) -and -not (Test-Path $PortableCodexExe)) {
    Write-Host "Codex CLI is not installed in this portable kit yet."
    Write-Host "Run:"
    Write-Host "  .\Install-UsbCodex.ps1"
    exit 1
}

if (-not (Test-Path $GuiServer)) {
    throw "GUI server is missing: $GuiServer"
}

$url = "http://127.0.0.1:$Port"
try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $connected = $client.ConnectAsync("127.0.0.1", $Port).Wait(400)
    $client.Close()
    if ($connected) {
        Write-Host "Portable Codex GUI already appears to be running."
        Write-Host "Opening $url"
        if (-not $NoBrowser) {
            Start-Process $url | Out-Null
        }
        exit 0
    }
}
catch {
    # If the quick port probe fails, continue and let Node report any real startup error.
}

Write-Host "Starting Portable Codex GUI..."
Write-Host "URL=$url"
Write-Host "CODEX_HOME=$CodexHome"

if (-not $NoBrowser) {
    Start-Process $url | Out-Null
}

& (Join-Path $NodeDir "node.exe") $GuiServer --port $Port
