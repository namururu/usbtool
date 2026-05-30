param(
    [string]$OutputDir = "dist",
    [string]$PackageName = "portable-codex-usb.zip",
    [switch]$WriteManifest
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutputPath = Join-Path $Root $OutputDir
$ZipPath = Join-Path $OutputPath $PackageName
$IncludeFile = Join-Path $Root ".portable-update-include"

if (-not (Test-Path $IncludeFile)) {
    throw "Missing include file: $IncludeFile"
}

New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null
if (Test-Path $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
}

$stage = Join-Path $Root ".tmp\update-package"
if (Test-Path $stage) {
    $resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $resolvedStage = [System.IO.Path]::GetFullPath($stage).TrimEnd('\') + '\'
    if (-not $resolvedStage.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove staging path outside root: $stage"
    }
    Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$patterns = Get-Content $IncludeFile |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and -not $_.StartsWith("#") }

foreach ($pattern in $patterns) {
    if ($pattern.EndsWith("/**")) {
        $sourceRel = $pattern.Substring(0, $pattern.Length - 3)
        $source = Join-Path $Root $sourceRel
        if (Test-Path $source) {
            $dest = Join-Path $stage $sourceRel
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
            Copy-Item -LiteralPath $source -Destination $dest -Recurse -Force
        }
        continue
    }

    $source = Join-Path $Root $pattern
    if (Test-Path $source) {
        $dest = Join-Path $stage $pattern
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
        Copy-Item -LiteralPath $source -Destination $dest -Force
    }
    else {
        Write-Warning "Included path does not exist: $pattern"
    }
}

Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $ZipPath -Force
$hash = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()

Write-Host "Created $ZipPath"
Write-Host "SHA256 $hash"

if ($WriteManifest) {
    $version = (Get-Content (Join-Path $Root "VERSION") -Raw).Trim()
    $manifest = [ordered]@{
        version = $version
        zipUrl = "https://github.com/YOUR_NAME/portable-codex-usb/releases/latest/download/$PackageName"
        sha256 = $hash
        notes = "Release $version"
    }
    $manifestPath = Join-Path $OutputPath "update.json"
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding UTF8
    Write-Host "Created $manifestPath"
}
