param(
    [string]$OutputDir = "usb",
    [switch]$IncludeRuntime,
    [switch]$FullRuntime,
    [switch]$IncludeAuth,
    [switch]$IncludeWorkspaces,
    [switch]$CleanOutput
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutputPath = if ([System.IO.Path]::IsPathRooted($OutputDir)) { $OutputDir } else { Join-Path $Root $OutputDir }
$AppOutput = Join-Path $OutputPath "portable-codex-usb"
$IncludeFile = Join-Path $Root ".portable-update-include"

function Assert-UnderRootOrExplicit {
    param([string]$PathToCheck)
    $resolved = [System.IO.Path]::GetFullPath($PathToCheck)
    if ($resolved -eq [System.IO.Path]::GetPathRoot($resolved)) {
        throw "Refusing filesystem root: $PathToCheck"
    }
}

function Copy-RelativePath {
    param([string]$RelativePath)

    if ($RelativePath.EndsWith("/**")) {
        $sourceRel = $RelativePath.Substring(0, $RelativePath.Length - 3)
        $source = Join-Path $Root $sourceRel
        if (Test-Path $source) {
            $dest = Join-Path $AppOutput $sourceRel
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
            Copy-Item -LiteralPath $source -Destination $dest -Recurse -Force
        }
        return
    }

    $sourceFile = Join-Path $Root $RelativePath
    if (Test-Path $sourceFile) {
        $destFile = Join-Path $AppOutput $RelativePath
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destFile) | Out-Null
        Copy-Item -LiteralPath $sourceFile -Destination $destFile -Force
    }
}

function Copy-DirectoryRobust {
    param(
        [string]$Source,
        [string]$Destination
    )

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    & robocopy.exe $Source $Destination /E /NFL /NDL /NJH /NJS /NP | Out-Null
    $code = $LASTEXITCODE
    if ($code -ge 8) {
        throw "robocopy failed with exit code $code while copying $Source"
    }
}

function Remove-DirectoryRobust {
    param([string]$Target)
    if (-not (Test-Path $Target)) {
        return
    }
    $empty = Join-Path $Root ".tmp\empty-remove"
    if (Test-Path $empty) {
        Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force -Path $empty | Out-Null
    & robocopy.exe $empty $Target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path $IncludeFile)) {
    throw "Missing include file: $IncludeFile"
}

Assert-UnderRootOrExplicit $OutputPath

if ($CleanOutput -and (Test-Path $OutputPath)) {
    Remove-DirectoryRobust $OutputPath
}

New-Item -ItemType Directory -Force -Path $AppOutput | Out-Null

$patterns = Get-Content $IncludeFile |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and -not $_.StartsWith("#") }

foreach ($pattern in $patterns) {
    Copy-RelativePath $pattern
}

if ($IncludeRuntime -and $FullRuntime) {
    foreach ($relative in @("tools\node", "tools\npm-global", "tools\python")) {
        $source = Join-Path $Root $relative
        if (Test-Path $source) {
            $dest = Join-Path $AppOutput $relative
            Copy-DirectoryRobust -Source $source -Destination $dest
        }
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $AppOutput "tools\npm-cache") | Out-Null
}
elseif ($IncludeRuntime) {
    $sourceNode = Join-Path $Root "tools\node\node.exe"
    $destNode = Join-Path $AppOutput "tools\node\node.exe"
    if (Test-Path $sourceNode) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destNode) | Out-Null
        Copy-Item -LiteralPath $sourceNode -Destination $destNode -Force
    }

    $sourceCodexVendor = Join-Path $Root "tools\npm-global\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc"
    $destCodexVendor = Join-Path $AppOutput "tools\codex\vendor\x86_64-pc-windows-msvc"
    if (Test-Path $sourceCodexVendor) {
        Copy-DirectoryRobust -Source $sourceCodexVendor -Destination $destCodexVendor
    }
    else {
        Write-Warning "Native Codex vendor directory was not found. Falling back to no bundled Codex runtime."
    }

    $sourcePython = Join-Path $Root "tools\python"
    $destPython = Join-Path $AppOutput "tools\python"
    if (Test-Path $sourcePython) {
        Copy-DirectoryRobust -Source $sourcePython -Destination $destPython
    }

    New-Item -ItemType Directory -Force -Path (Join-Path $AppOutput "tools\npm-cache") | Out-Null
}

if ($IncludeAuth) {
    $source = Join-Path $Root "data\codex-home"
    if (Test-Path $source) {
        $dest = Join-Path $AppOutput "data\codex-home"
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
        Copy-Item -LiteralPath $source -Destination $dest -Recurse -Force
    }
}
else {
    New-Item -ItemType Directory -Force -Path (Join-Path $AppOutput "data\codex-home") | Out-Null
}

if ($IncludeWorkspaces) {
    $source = Join-Path $Root "workspaces"
    if (Test-Path $source) {
        Copy-Item -LiteralPath $source -Destination (Join-Path $AppOutput "workspaces") -Recurse -Force
    }
}
else {
    New-Item -ItemType Directory -Force -Path (Join-Path $AppOutput "workspaces") | Out-Null
}

$runtimeNote = if ($IncludeRuntime -and $FullRuntime) {
    "- Full runtime tools/node and tools/npm-global"
}
elseif ($IncludeRuntime) {
    if (Test-Path (Join-Path $Root "tools\python\python.exe")) {
        "- Minimal runtime node.exe, native codex.exe, and portable Python"
    }
    else {
        "- Minimal runtime node.exe and native codex.exe"
    }
}
else {
    "- Runtime not included"
}

@"
Portable Codex USB carry package

Created: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

Included:
- App scripts and GUI
- Empty data/codex-home unless -IncludeAuth was used
- Empty workspaces unless -IncludeWorkspaces was used
$runtimeNote

Start:
  start.bat

Clean:
  clean.bat
"@ | Set-Content -Path (Join-Path $AppOutput "CARRY-NOTES.txt") -Encoding UTF8

Write-Host "Created carry folder:"
Write-Host $AppOutput

if (-not $IncludeRuntime) {
    Write-Host ""
    Write-Host "Runtime was not included. Run Install-UsbCodex.ps1 on the target USB before first use."
}
