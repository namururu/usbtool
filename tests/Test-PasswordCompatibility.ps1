$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

foreach ($test in @(
    @{ File = "Start-CodexRemote.ps1"; Function = "New-RemotePassword"; Length = 36 },
    @{ File = "Start-CodexGui.ps1"; Function = "New-SharePassword"; Length = 24 }
)) {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $root $test.File), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw "Parse failed: $($test.File)" }
    $function = $ast.Find({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq $test.Function
    }, $true)
    if (-not $function) { throw "Missing function: $($test.Function)" }
    . ([scriptblock]::Create($function.Extent.Text))
    $values = @(1..100 | ForEach-Object { & $test.Function })
    foreach ($value in $values) {
        if ($value -cnotmatch ('^[0-9a-f]{' + $test.Length + '}$')) {
            throw "Invalid password format: $($test.Function)"
        }
    }
    if (@($values | Select-Object -Unique).Count -ne 100) { throw "Repeated passwords" }
    Write-Output "PASS $($test.Function) on PowerShell $($PSVersionTable.PSVersion)"
}

# Exercise first-run persistence without touching real credentials or starting a server.
$testBase = Join-Path $root ".tmp"
$testRoot = Join-Path $testBase ("password-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
try {
    Copy-Item -LiteralPath (Join-Path $root "Start-CodexRemote.ps1") -Destination $testRoot
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "fixtures\Start-CodexGui.ps1") -Destination $testRoot
    & (Join-Path $testRoot "Start-CodexRemote.ps1") *> $null
    $first = Get-Content (Join-Path $testRoot "data\remote-console.json") -Raw | ConvertFrom-Json
    if ($first.password -cnotmatch '^[0-9a-f]{36}$') { throw "First-run password missing" }
    & (Join-Path $testRoot "Start-CodexRemote.ps1") *> $null
    $second = Get-Content (Join-Path $testRoot "data\remote-console.json") -Raw | ConvertFrom-Json
    if ($second.password -cne $first.password) { throw "Saved password changed on restart" }
    & (Join-Path $testRoot "Start-CodexRemote.ps1") -ResetPassword *> $null
    $third = Get-Content (Join-Path $testRoot "data\remote-console.json") -Raw | ConvertFrom-Json
    if ($third.password -ceq $first.password) { throw "Reset did not replace password" }
    Write-Output "PASS remote first launch, password reuse, and reset"
}
finally {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $allowed = [IO.Path]::GetFullPath($testBase).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing cleanup outside test directory"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
