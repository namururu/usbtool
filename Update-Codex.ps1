param(
    [switch]$Auto,
    [switch]$Force,
    [switch]$Quiet,
    [int]$CheckIntervalHours = 12
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ToolsDir = Join-Path $Root "tools"
$NodeDir = Join-Path $ToolsDir "node"
$NpmPrefix = Join-Path $ToolsDir "npm-global"
$NpmCache = Join-Path $ToolsDir "npm-cache"
$CodexHome = Join-Path $Root "data\codex-home"
$DataDir = Join-Path $Root "data"
$TmpDir = Join-Path $Root ".tmp\codex-cli-update"
$StatusFile = Join-Path $DataDir "codex-cli-update-status.json"
$NativeVendorDir = Join-Path $Root "tools\codex\vendor\x86_64-pc-windows-msvc"
$NativeCodexExe = Join-Path $NativeVendorDir "bin\codex.exe"
$NpmCodexCmd = Join-Path $NpmPrefix "codex.cmd"
$NpmCodexPackage = Join-Path $NpmPrefix "node_modules\@openai\codex\package.json"
$NpmNativeVendorDir = Join-Path $NpmPrefix "node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc"

function Write-Info {
    param([string]$Message)
    if (-not $Quiet) {
        Write-Host $Message
    }
}

function Write-JsonFile {
    param(
        [string]$Path,
        [object]$Value
    )
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    $Value | ConvertTo-Json -Depth 8 | Set-Content -Path $Path -Encoding UTF8
}

function Read-JsonFile {
    param(
        [string]$Path,
        [object]$Fallback
    )
    try {
        if (Test-Path $Path) {
            return Get-Content -Path $Path -Raw | ConvertFrom-Json
        }
    }
    catch {
        return $Fallback
    }
    return $Fallback
}

function Write-Status {
    param(
        [string]$Status,
        [string]$Message,
        [string]$InstalledVersion = "",
        [string]$LatestVersion = ""
    )
    Write-JsonFile -Path $StatusFile -Value ([ordered]@{
        checkedAt = (Get-Date).ToString("o")
        status = $Status
        message = $Message
        installedVersion = $InstalledVersion
        latestVersion = $LatestVersion
    })
}

function Add-PathFirst {
    param([string]$PathToAdd)
    if (-not (Test-Path $PathToAdd)) {
        return
    }
    $parts = $env:Path -split ';' | Where-Object { $_ -and ($_ -ne $PathToAdd) }
    $env:Path = @($PathToAdd) + $parts -join ';'
}

function Assert-UnderRoot {
    param([string]$PathToCheck)
    $resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $resolvedPath = [System.IO.Path]::GetFullPath($PathToCheck).TrimEnd('\') + '\'
    if (-not $resolvedPath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing path outside portable root: $PathToCheck"
    }
}

function Remove-DirectoryRobust {
    param([string]$Target)
    if (-not (Test-Path $Target)) {
        return
    }
    Assert-UnderRoot $Target
    $empty = Join-Path $Root ".tmp\empty-codex-update"
    if (Test-Path $empty) {
        Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force -Path $empty | Out-Null
    & robocopy.exe $empty $Target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue
}

function Copy-DirectoryRobust {
    param(
        [string]$Source,
        [string]$Destination
    )
    Assert-UnderRoot $Destination
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    & robocopy.exe $Source $Destination /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    $code = $LASTEXITCODE
    if ($code -ge 8) {
        throw "robocopy failed with exit code $code while copying Codex CLI."
    }
}

function Convert-ToVersion {
    param([string]$Value)
    $match = [regex]::Match([string]$Value, '\d+\.\d+\.\d+')
    if (-not $match.Success) {
        return [version]"0.0.0"
    }
    return [version]$match.Value
}

function Get-InstalledCodexVersion {
    if (Test-Path $NpmCodexPackage) {
        try {
            $package = Get-Content -Path $NpmCodexPackage -Raw | ConvertFrom-Json
            if ($package.version) {
                return [string]$package.version
            }
        }
        catch {}
    }
    if (Test-Path $NativeCodexExe) {
        try {
            $output = & $NativeCodexExe --version 2>$null
            $match = [regex]::Match(($output -join " "), '\d+\.\d+\.\d+')
            if ($match.Success) {
                return $match.Value
            }
        }
        catch {}
    }
    return "0.0.0"
}

function Get-LatestCodexMetadata {
    Invoke-RestMethod -Uri "https://registry.npmjs.org/@openai/codex/latest" -UseBasicParsing
}

function Get-NativeCodexMetadata {
    param([string]$Version)
    Invoke-RestMethod -Uri "https://registry.npmjs.org/@openai/codex/$Version-win32-x64" -UseBasicParsing
}

function Sync-NpmNativeCodex {
    if (-not (Test-Path $NpmNativeVendorDir)) {
        return $false
    }
    Remove-DirectoryRobust $NativeVendorDir
    Copy-DirectoryRobust -Source $NpmNativeVendorDir -Destination $NativeVendorDir
    return $true
}

function Install-CodexWithNpm {
    $npmCmd = Join-Path $NodeDir "npm.cmd"
    if (-not (Test-Path $npmCmd)) {
        return $false
    }
    Add-PathFirst $NodeDir
    Add-PathFirst $NpmPrefix
    $env:npm_config_prefix = $NpmPrefix
    $env:npm_config_cache = $NpmCache
    $env:CODEX_HOME = $CodexHome
    Write-Info "Installing latest @openai/codex with npm..."
    & $npmCmd install -g "@openai/codex@latest"
    if ($LASTEXITCODE -ne 0) {
        throw "npm install @openai/codex@latest failed with exit code $LASTEXITCODE."
    }
    if (-not (Sync-NpmNativeCodex)) {
        throw "npm updated @openai/codex, but native Windows Codex package was not found."
    }
    return $true
}

function Install-CodexNativeTarball {
    param([object]$Latest)

    $version = [string]$Latest.version
    $native = Get-NativeCodexMetadata -Version $version
    $tarball = [string]$native.dist.tarball
    if (-not $tarball) {
        throw "Native Codex package metadata is missing tarball URL."
    }

    if (Test-Path $TmpDir) {
        Remove-DirectoryRobust $TmpDir
    }
    New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

    $tarPath = Join-Path $TmpDir "codex-win32-x64.tgz"
    $extractDir = Join-Path $TmpDir "extract"
    New-Item -ItemType Directory -Force -Path $extractDir | Out-Null

    Write-Info "Downloading Codex CLI $version native Windows package..."
    Invoke-WebRequest -Uri $tarball -OutFile $tarPath -UseBasicParsing

    if ($native.dist.shasum) {
        $actual = (Get-FileHash -Path $tarPath -Algorithm SHA1).Hash.ToLowerInvariant()
        $expected = ([string]$native.dist.shasum).ToLowerInvariant()
        if ($actual -ne $expected) {
            throw "Codex native package SHA1 mismatch. Expected $expected but got $actual."
        }
    }

    & tar.exe -xzf $tarPath -C $extractDir
    if ($LASTEXITCODE -ne 0) {
        throw "tar extraction failed with exit code $LASTEXITCODE."
    }

    $codexExe = Get-ChildItem -Path $extractDir -Recurse -Filter "codex.exe" |
        Where-Object { $_.FullName -like "*\vendor\x86_64-pc-windows-msvc\bin\codex.exe" } |
        Select-Object -First 1
    if (-not $codexExe) {
        throw "Downloaded native Codex package did not contain vendor\x86_64-pc-windows-msvc\bin\codex.exe."
    }

    $vendorDir = Split-Path -Parent (Split-Path -Parent $codexExe.FullName)
    Remove-DirectoryRobust $NativeVendorDir
    Copy-DirectoryRobust -Source $vendorDir -Destination $NativeVendorDir
}

function Test-RecentlyChecked {
    if ($Force -or -not $Auto) {
        return $false
    }
    $status = Read-JsonFile -Path $StatusFile -Fallback ([pscustomobject]@{})
    if (-not $status.checkedAt) {
        return $false
    }
    try {
        $checkedAt = [datetime]$status.checkedAt
        return ((Get-Date) - $checkedAt).TotalHours -lt $CheckIntervalHours
    }
    catch {
        return $false
    }
}

try {
    New-Item -ItemType Directory -Force -Path $ToolsDir, $NpmPrefix, $NpmCache, $DataDir, $CodexHome | Out-Null

    if (Test-RecentlyChecked) {
        Write-Info "Codex CLI update check skipped; checked within $CheckIntervalHours hours."
        exit 0
    }

    $installed = Get-InstalledCodexVersion
    $latest = Get-LatestCodexMetadata
    $latestVersion = [string]$latest.version

    if (-not $Force -and ((Convert-ToVersion $installed) -ge (Convert-ToVersion $latestVersion))) {
        $message = "Codex CLI is up to date ($installed)."
        Write-Info $message
        Write-Status -Status "up-to-date" -Message $message -InstalledVersion $installed -LatestVersion $latestVersion
        exit 0
    }

    $message = "Updating Codex CLI from $installed to $latestVersion..."
    Write-Info $message
    Write-Status -Status "updating" -Message $message -InstalledVersion $installed -LatestVersion $latestVersion

    if (-not (Install-CodexWithNpm)) {
        Install-CodexNativeTarball -Latest $latest
    }

    $newVersion = Get-InstalledCodexVersion
    $done = "Codex CLI updated to $newVersion."
    Write-Info $done
    Write-Status -Status "updated" -Message $done -InstalledVersion $newVersion -LatestVersion $latestVersion
}
catch {
    $message = $_.Exception.Message
    Write-Info "Codex CLI update failed: $message"
    Write-Status -Status "failed" -Message $message -InstalledVersion (Get-InstalledCodexVersion)
    if (-not $Auto) {
        throw
    }
    exit 0
}
