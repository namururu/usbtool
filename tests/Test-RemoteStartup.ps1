$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$testBase = Join-Path $root ".tmp"
$testRoot = Join-Path $testBase ("remote startup " + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
try {
    foreach ($scenario in @("working", "missing-node")) {
        $kit = Join-Path $testRoot $scenario
        New-Item -ItemType Directory -Path (Join-Path $kit "tools\node"),(Join-Path $kit "tools\npm-global"),(Join-Path $kit "gui") -Force | Out-Null
        foreach ($file in @("Start-CodexRemote.ps1", "Start-CodexGui.ps1")) {
            Copy-Item -LiteralPath (Join-Path $root $file) -Destination $kit
        }
        Copy-Item -LiteralPath (Join-Path $root "gui\server.js") -Destination (Join-Path $kit "gui")
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot "fixtures\codex.cmd") -Destination (Join-Path $kit "tools\npm-global")
        if ($scenario -eq "working") {
            Copy-Item -LiteralPath (Join-Path $root "tools\node\node.exe") -Destination (Join-Path $kit "tools\node")
        }
        $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
        $probe.Start()
        $port = $probe.LocalEndpoint.Port
        $probe.Stop()
        $launcher = $null
        try {
            $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $kit "Start-CodexRemote.ps1") + '" -Background -Port ' + $port
            $launcher = Start-Process powershell.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput (Join-Path $kit "launcher.log") -RedirectStandardError (Join-Path $kit "launcher.err.log")
            $null = $launcher.Handle
            if (-not $launcher.WaitForExit(45000)) { throw "Launcher hung: $scenario" }
            $startup = Get-Content (Join-Path $kit "data\remote-startup.json") -Raw | ConvertFrom-Json
            if ($scenario -eq "working") {
                if ($launcher.ExitCode -ne 0 -or $startup.status -ne "running") { throw "Background startup failed: exit=$($launcher.ExitCode) status=$($startup.status) $($startup.message)" }
                $health = Invoke-RestMethod "http://127.0.0.1:$port/api/status?light=1" -TimeoutSec 3
                if ($health.root -ne $kit -or -not $health.remoteConsole) { throw "Wrong server identity" }
                Write-Output "PASS Windows PowerShell background server survives launcher exit in a spaced path"
            }
            else {
                if ($launcher.ExitCode -eq 0 -or $startup.status -ne "failed") { throw "Missing node was reported as success" }
                if (-not $startup.message.Contains("node.exe")) { throw "Missing node diagnostic lost: $($startup.message)" }
                $config = Get-Content (Join-Path $kit "data\remote-console.json") -Raw | ConvertFrom-Json
                if ($startup.message.Contains($config.password)) { throw "Password leaked into startup status" }
                Write-Output "PASS startup failure is nonzero with a persistent redacted diagnostic"
            }
        }
        finally {
            if ($launcher -and -not $launcher.HasExited) { & taskkill.exe /PID $launcher.Id /T /F | Out-Null }
            $children = @(Get-CimInstance Win32_Process | Where-Object {
                $_.CommandLine -and $_.CommandLine.Contains($kit) -and $_.ProcessId -ne $PID
            })
            foreach ($child in $children) {
                Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
            }
            Start-Sleep -Seconds 1
        }
    }
}
finally {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $allowed = [IO.Path]::GetFullPath($testBase).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw "Invalid cleanup path" }
    for ($attempt = 0; $attempt -lt 5 -and (Test-Path $resolved); $attempt++) {
        try { Remove-Item -LiteralPath $resolved -Recurse -Force }
        catch { if ($attempt -eq 4) { Write-Warning "Test cleanup incomplete: $resolved" }; Start-Sleep -Seconds 1 }
    }
}
