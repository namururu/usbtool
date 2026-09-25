param(
    [switch]$Quiet,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ToolDir = Join-Path $Root "tools\cloudflared"
$CloudflaredExe = Join-Path $ToolDir "cloudflared.exe"
$DownloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"

if ((Test-Path $CloudflaredExe) -and -not $Force) {
    if (-not $Quiet) {
        Write-Host "cloudflared is already installed."
    }
    exit 0
}

New-Item -ItemType Directory -Force -Path $ToolDir | Out-Null
$TemporaryFile = "$CloudflaredExe.download"

try {
    if (-not $Quiet) {
        Write-Host "Downloading cloudflared for Windows x64..."
    }
    Invoke-WebRequest -UseBasicParsing -Uri $DownloadUrl -OutFile $TemporaryFile
    Move-Item -LiteralPath $TemporaryFile -Destination $CloudflaredExe -Force
    if (-not $Quiet) {
        & $CloudflaredExe --version
    }
}
finally {
    Remove-Item -LiteralPath $TemporaryFile -Force -ErrorAction SilentlyContinue
}
