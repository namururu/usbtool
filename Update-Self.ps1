param(
    [string]$ManifestUrl = "",
    [switch]$Force,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = Join-Path $Root "data"
$TmpDir = Join-Path $Root ".tmp\self-update"
$LocalVersionFile = Join-Path $Root "VERSION"
$DefaultManifestFile = Join-Path $Root "update.json"

function Write-Info {
    param([string]$Message)
    if (-not $Quiet) {
        Write-Host $Message
    }
}

function Get-VersionValue {
    param([string]$Value)
    try {
        return [version]$Value
    }
    catch {
        return [version]"0.0.0"
    }
}

function Assert-UnderRoot {
    param([string]$PathToCheck)
    $resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $resolvedPath = [System.IO.Path]::GetFullPath($PathToCheck).TrimEnd('\') + '\'
    if (-not $resolvedPath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing path outside portable root: $PathToCheck"
    }
}

function Copy-UpdateItem {
    param(
        [string]$Source,
        [string]$RelativePath
    )

    $destination = Join-Path $Root $RelativePath
    Assert-UnderRoot $destination

    if ((Get-Item $Source).PSIsContainer) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath $Source -Destination $destination -Recurse -Force
    }
    else {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath $Source -Destination $destination -Force
    }
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

if (-not $ManifestUrl) {
    $localManifest = Get-Content $DefaultManifestFile -Raw | ConvertFrom-Json
    $ManifestUrl = $localManifest.manifestUrl
    if (-not $ManifestUrl) {
        $ManifestUrl = $env:PORTABLE_CODEX_UPDATE_MANIFEST
    }
}

if (-not $ManifestUrl) {
    Write-Info "No update manifest URL configured."
    exit 0
}

if (Test-Path $TmpDir) {
    Assert-UnderRoot $TmpDir
    Remove-Item -LiteralPath $TmpDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

$manifestPath = Join-Path $TmpDir "update.json"
try {
    if (Test-Path $ManifestUrl) {
        Copy-Item -LiteralPath $ManifestUrl -Destination $manifestPath -Force
    }
    else {
        Invoke-WebRequest -Uri $ManifestUrl -OutFile $manifestPath -UseBasicParsing
    }
}
catch {
    Write-Info "Update check failed: $($_.Exception.Message)"
    exit 0
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$currentVersion = if (Test-Path $LocalVersionFile) { (Get-Content $LocalVersionFile -Raw).Trim() } else { "0.0.0" }
$remoteVersion = [string]$manifest.version

if (-not $Force -and (Get-VersionValue $remoteVersion) -le (Get-VersionValue $currentVersion)) {
    Write-Info "Portable Codex GUI is up to date ($currentVersion)."
    exit 0
}

if (-not $manifest.zipUrl) {
    throw "Manifest is missing zipUrl."
}

$zipPath = Join-Path $TmpDir "update.zip"
Write-Info "Downloading Portable Codex GUI $remoteVersion..."
if (Test-Path ([string]$manifest.zipUrl)) {
    Copy-Item -LiteralPath ([string]$manifest.zipUrl) -Destination $zipPath -Force
}
else {
    Invoke-WebRequest -Uri $manifest.zipUrl -OutFile $zipPath -UseBasicParsing
}

if ($manifest.sha256) {
    $actualHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $expectedHash = ([string]$manifest.sha256).ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "Update SHA256 mismatch. Expected $expectedHash but got $actualHash."
    }
}

$extractDir = Join-Path $TmpDir "extract"
Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

$protectedRoots = @(
    "data",
    "tools",
    "workspaces",
    "dist",
    ".tmp"
)

Get-ChildItem -Path $extractDir -Force | ForEach-Object {
    $relative = $_.Name
    if ($protectedRoots -contains $relative) {
        Write-Info "Skipping protected path from update: $relative"
        return
    }
    Copy-UpdateItem -Source $_.FullName -RelativePath $relative
}

if ($remoteVersion) {
    Set-Content -Path $LocalVersionFile -Value $remoteVersion -Encoding ASCII
}

Write-Info "Updated Portable Codex GUI to $remoteVersion."
