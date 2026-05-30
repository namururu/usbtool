param(
    [string]$PythonVersion = "3.13.13",
    [switch]$NoPip,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ToolsDir = Join-Path $Root "tools"
$PythonDir = Join-Path $ToolsDir "python"
$TmpDir = Join-Path $Root ".tmp"

New-Item -ItemType Directory -Force -Path $ToolsDir, $TmpDir | Out-Null

function Assert-UnderRoot {
    param([string]$PathToCheck)
    $resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $resolvedPath = [System.IO.Path]::GetFullPath($PathToCheck).TrimEnd('\') + '\'
    if (-not $resolvedPath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove path outside portable root: $PathToCheck"
    }
}

function Write-CmdShim {
    param(
        [string]$Path,
        [string]$Target,
        [string[]]$ExtraArgs = @()
    )
    $args = if ($ExtraArgs.Count) { " $($ExtraArgs -join ' ')" } else { "" }
@"
@echo off
set "PYTHONHOME=%~dp0"
"%~dp0$Target"$args %*
"@ | Set-Content -Path $Path -Encoding ASCII
}

$pythonExe = Join-Path $PythonDir "python.exe"
if ($Force -or -not (Test-Path $pythonExe)) {
    Write-Host "Downloading Python $PythonVersion embeddable runtime for Windows x64..."
    $zipName = "python-$PythonVersion-embed-amd64.zip"
    $zipUrl = "https://www.python.org/ftp/python/$PythonVersion/$zipName"
    $zipPath = Join-Path $TmpDir $zipName

    if (Test-Path $PythonDir) {
        Assert-UnderRoot $PythonDir
        Remove-Item -LiteralPath $PythonDir -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $PythonDir | Out-Null

    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
    Expand-Archive -Path $zipPath -DestinationPath $PythonDir -Force
    Remove-Item -LiteralPath $zipPath -Force
}
else {
    Write-Host "Using existing portable Python at $PythonDir"
}

$pth = Get-ChildItem -Path $PythonDir -Filter "python*._pth" | Select-Object -First 1
if ($pth) {
    $content = Get-Content -LiteralPath $pth.FullName
    $content = $content | ForEach-Object {
        if ($_ -eq "#import site") { "import site" } else { $_ }
    }
    $content | Set-Content -LiteralPath $pth.FullName -Encoding ASCII
}

Write-CmdShim -Path (Join-Path $PythonDir "python.cmd") -Target "python.exe"

if (-not $NoPip) {
    $pipExe = Join-Path $PythonDir "Scripts\pip.exe"
    if ($Force -or -not (Test-Path $pipExe)) {
        Write-Host "Installing pip into portable Python..."
        $getPip = Join-Path $TmpDir "get-pip.py"
        Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPip
        & $pythonExe $getPip --no-warn-script-location
        Remove-Item -LiteralPath $getPip -Force
    }
    Write-CmdShim -Path (Join-Path $PythonDir "pip.cmd") -Target "python.exe" -ExtraArgs @("-m", "pip")
}

Write-Host ""
Write-Host "Python runtime is ready:"
& $pythonExe --version
if (-not $NoPip) {
    & $pythonExe -m pip --version
}
Write-Host ""
Write-Host "Path:"
Write-Host "  $PythonDir"
