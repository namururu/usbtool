param(
    [string]$NodeMajor = "22",
    [switch]$ForceNode,
    [switch]$ForceCodex
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ToolsDir = Join-Path $Root "tools"
$NodeDir = Join-Path $ToolsDir "node"
$NpmPrefix = Join-Path $ToolsDir "npm-global"
$NpmCache = Join-Path $ToolsDir "npm-cache"
$DataDir = Join-Path $Root "data"
$CodexHome = Join-Path $DataDir "codex-home"
$WorkspaceDir = Join-Path $Root "workspaces"
$TmpDir = Join-Path $Root ".tmp"

New-Item -ItemType Directory -Force -Path $ToolsDir, $NpmPrefix, $NpmCache, $DataDir, $CodexHome, $WorkspaceDir, $TmpDir | Out-Null

function Add-PathFirst {
    param([string]$PathToAdd)
    $parts = $env:Path -split ';' | Where-Object { $_ -and ($_ -ne $PathToAdd) }
    $env:Path = @($PathToAdd) + $parts -join ';'
}

function Assert-UnderRoot {
    param([string]$PathToCheck)
    $resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $resolvedPath = [System.IO.Path]::GetFullPath($PathToCheck).TrimEnd('\') + '\'
    if (-not $resolvedPath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove path outside portable root: $PathToCheck"
    }
}

$nodeExe = Join-Path $NodeDir "node.exe"
if ($ForceNode -or -not (Test-Path $nodeExe)) {
    Write-Host "Downloading portable Node.js v$NodeMajor.x for Windows x64..."
    $index = Invoke-RestMethod "https://nodejs.org/dist/index.json"
    $release = $index |
        Where-Object { $_.version -like "v$NodeMajor.*" -and $_.files -contains "win-x64-zip" } |
        Select-Object -First 1

    if (-not $release) {
        throw "Could not find a Windows x64 Node.js v$NodeMajor release."
    }

    $zipName = "node-$($release.version)-win-x64.zip"
    $zipUrl = "https://nodejs.org/dist/$($release.version)/$zipName"
    $zipPath = Join-Path $TmpDir $zipName
    $extractDir = Join-Path $TmpDir "node-extract"

    if (Test-Path $extractDir) {
        Assert-UnderRoot $extractDir
        Remove-Item -LiteralPath $extractDir -Recurse -Force
    }
    if (Test-Path $NodeDir) {
        Assert-UnderRoot $NodeDir
        Remove-Item -LiteralPath $NodeDir -Recurse -Force
    }

    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

    $expandedNode = Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1
    if (-not $expandedNode) {
        throw "Node.js archive extraction did not produce a directory."
    }

    Move-Item -LiteralPath $expandedNode.FullName -Destination $NodeDir
    if (Test-Path $extractDir) {
        Assert-UnderRoot $extractDir
        Remove-Item -LiteralPath $extractDir -Recurse -Force
    }
    if (Test-Path $zipPath) {
        Remove-Item -LiteralPath $zipPath -Force
    }
    Write-Host "Installed Node.js $($release.version) into $NodeDir"
}
else {
    Write-Host "Using existing portable Node.js at $NodeDir"
}

Add-PathFirst $NodeDir
Add-PathFirst $NpmPrefix

$env:npm_config_prefix = $NpmPrefix
$env:npm_config_cache = $NpmCache
$env:CODEX_HOME = $CodexHome

Write-Host "Node:"
node --version
Write-Host "npm:"
npm --version

$codexCmd = Join-Path $NpmPrefix "codex.cmd"
if ($ForceCodex -or -not (Test-Path $codexCmd)) {
    Write-Host "Installing latest @openai/codex into the USB npm prefix..."
    npm install -g "@openai/codex@latest"
}
else {
    Write-Host "Using existing Codex CLI at $codexCmd"
}

if (-not (Test-Path (Join-Path $CodexHome "config.toml"))) {
    @"
# Portable Codex CLI config.
# This file lives on the USB drive because Start-Codex.ps1 sets CODEX_HOME.
#
# Keep this minimal. Add project- or team-specific settings here later if needed.
"@ | Set-Content -Path (Join-Path $CodexHome "config.toml") -Encoding UTF8
}

Write-Host ""
Write-Host "Portable Codex is ready."
Write-Host "Next:"
Write-Host "  .\Start-Codex.ps1"
