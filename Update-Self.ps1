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
$UpdateStateFile = Join-Path $DataDir "update-state.json"
$UpdateStatusFile = Join-Path $DataDir "update-status.json"

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

function Read-JsonFile {
    param(
        [string]$Path,
        [object]$Fallback
    )
    try {
        if (Test-Path $Path) {
            return Get-Content $Path -Raw | ConvertFrom-Json
        }
    }
    catch {
        return $Fallback
    }
    return $Fallback
}

function Write-JsonFile {
    param(
        [string]$Path,
        [object]$Value
    )
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    $Value | ConvertTo-Json -Depth 8 | Set-Content -Path $Path -Encoding UTF8
}

function Write-UpdateStatus {
    param(
        [string]$Status,
        [string]$Message,
        [object]$Manifest = $null
    )
    Write-JsonFile -Path $UpdateStatusFile -Value ([ordered]@{
        checkedAt = (Get-Date).ToString("o")
        status = $Status
        message = $Message
        version = if ($Manifest) { [string]$Manifest.version } else { "" }
        buildId = if ($Manifest) { [string]$Manifest.buildId } else { "" }
    })
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
    Write-UpdateStatus -Status "check-failed" -Message $_.Exception.Message
    exit 0
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$currentVersion = if (Test-Path $LocalVersionFile) { (Get-Content $LocalVersionFile -Raw).Trim() } else { "0.0.0" }
$remoteVersion = [string]$manifest.version
$remoteBuildId = [string]$manifest.buildId
$localState = Read-JsonFile -Path $UpdateStateFile -Fallback ([pscustomobject]@{})
$localBuildId = [string]$localState.buildId

$remoteNewerVersion = (Get-VersionValue $remoteVersion) -gt (Get-VersionValue $currentVersion)
$sameVersionNewBuild = $remoteBuildId -and ($remoteBuildId -ne $localBuildId)

if (-not $Force -and -not $remoteNewerVersion -and -not $sameVersionNewBuild) {
    Write-Info "Portable Codex GUI is up to date ($currentVersion)."
    Write-UpdateStatus -Status "up-to-date" -Message "Portable Codex GUI is up to date ($currentVersion)." -Manifest $manifest
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

Write-JsonFile -Path $UpdateStateFile -Value ([ordered]@{
    version = $remoteVersion
    buildId = $remoteBuildId
    updatedAt = (Get-Date).ToString("o")
})

$message = if ($remoteBuildId) {
    "Updated Portable Codex GUI to $remoteVersion ($($remoteBuildId.Substring(0, [Math]::Min(7, $remoteBuildId.Length))))."
}
else {
    "Updated Portable Codex GUI to $remoteVersion."
}
Write-Info $message
Write-UpdateStatus -Status "updated" -Message $message -Manifest $manifest
