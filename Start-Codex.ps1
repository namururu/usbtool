param(
    [string]$Workspace = "",
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CodexArgs
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeDir = Join-Path $Root "tools\node"
$NpmPrefix = Join-Path $Root "tools\npm-global"
$NpmCache = Join-Path $Root "tools\npm-cache"
$CodexHome = Join-Path $Root "data\codex-home"
$DefaultWorkspace = Join-Path $Root "workspaces"

function Add-PathFirst {
    param([string]$PathToAdd)
    $parts = $env:Path -split ';' | Where-Object { $_ -and ($_ -ne $PathToAdd) }
    $env:Path = @($PathToAdd) + $parts -join ';'
}

New-Item -ItemType Directory -Force -Path $CodexHome, $DefaultWorkspace, $NpmCache | Out-Null

Add-PathFirst $NodeDir
Add-PathFirst $NpmPrefix

$env:npm_config_prefix = $NpmPrefix
$env:npm_config_cache = $NpmCache
$env:CODEX_HOME = $CodexHome

$codexCmd = Join-Path $NpmPrefix "codex.cmd"
if (-not (Test-Path $codexCmd)) {
    Write-Host "Codex CLI is not installed in this portable kit yet."
    Write-Host "Run:"
    Write-Host "  .\Install-UsbCodex.ps1"
    exit 1
}

if ($Workspace) {
    New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
    Set-Location $Workspace
}
else {
    Set-Location $DefaultWorkspace
}

Write-Host "CODEX_HOME=$env:CODEX_HOME"
Write-Host "Workspace=$(Get-Location)"
Write-Host ""

& $codexCmd @CodexArgs
