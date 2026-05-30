param(
    [switch]$Auth,
    [switch]$Workspaces,
    [switch]$All,
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = Join-Path $Root "data"

function Assert-UnderRoot {
    param([string]$PathToCheck)
    $resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $resolvedPath = [System.IO.Path]::GetFullPath($PathToCheck).TrimEnd('\')
    if ((Test-Path $PathToCheck -PathType Container) -or $PathToCheck.EndsWith('\')) {
        $resolvedPath += '\'
    }
    if (-not $resolvedPath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing path outside portable root: $PathToCheck"
    }
}

function Remove-PortablePath {
    param([string]$PathToRemove)
    if (-not (Test-Path $PathToRemove)) {
        return
    }
    Assert-UnderRoot $PathToRemove
    if ($WhatIf) {
        Write-Host "Would remove $PathToRemove"
    }
    else {
        Remove-Item -LiteralPath $PathToRemove -Recurse -Force
        Write-Host "Removed $PathToRemove"
    }
}

Write-Host "Portable Codex cleaner"
Write-Host "Root: $Root"
Write-Host ""

$paths = @(
    (Join-Path $DataDir "gui-history.json"),
    (Join-Path $DataDir "gui-state.json"),
    (Join-Path $DataDir "gui.log"),
    (Join-Path $DataDir "gui.err.log"),
    (Join-Path $DataDir "gui.pid"),
    (Join-Path $DataDir "upload-test.json"),
    (Join-Path $DataDir "uploads"),
    (Join-Path $DataDir "artifacts"),
    (Join-Path $DataDir "codex-home\generated_images"),
    (Join-Path $DataDir "codex-home\tmp"),
    (Join-Path $Root ".tmp")
)

foreach ($path in $paths) {
    Remove-PortablePath $path
}

$WorkspaceRoot = Join-Path $Root "workspaces"
if (Test-Path $WorkspaceRoot) {
    Get-ChildItem -LiteralPath $WorkspaceRoot -Directory -ErrorAction SilentlyContinue |
        ForEach-Object {
            Remove-PortablePath (Join-Path $_.FullName ".codex-attachments")
        }
}

if ($Auth -or $All) {
    Write-Host ""
    Write-Host "Removing Codex auth/session home..."
    Remove-PortablePath (Join-Path $DataDir "codex-home")
}

if ($Workspaces -or $All) {
    Write-Host ""
    Write-Host "Removing workspaces..."
    Remove-PortablePath (Join-Path $Root "workspaces")
}

if (-not $WhatIf) {
    New-Item -ItemType Directory -Force -Path (Join-Path $DataDir "codex-home"), (Join-Path $Root "workspaces") | Out-Null
}

Write-Host ""
if ($WhatIf) {
    Write-Host "Dry run complete. Nothing was removed."
}
else {
    Write-Host "Clean complete."
}
