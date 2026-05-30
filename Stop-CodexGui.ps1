param(
    [int]$Port = 41731,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')

function Write-Info {
    param([string]$Message)
    if (-not $Quiet) {
        Write-Host $Message
    }
}

$connections = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $connections) {
    Write-Info "Portable Codex GUI is not listening on port $Port."
    exit 0
}

foreach ($connection in $connections) {
    $pidToStop = $connection.OwningProcess
    if (-not $pidToStop) {
        continue
    }

    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$pidToStop" -ErrorAction SilentlyContinue
    $commandLine = if ($process) { [string]$process.CommandLine } else { "" }

    if ($commandLine -notlike "*gui\server.js*" -and $commandLine -notlike "*$resolvedRoot*") {
        Write-Info "Port $Port is used by another process. Refusing to stop PID $pidToStop."
        continue
    }

    Write-Info "Stopping Portable Codex GUI PID $pidToStop..."
    & taskkill.exe /PID $pidToStop /T /F | Out-Null
}
