param(
    [switch]$NoColors,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$CodexHome = Join-Path $Root "data\codex-home"
$ConfigPath = Join-Path $CodexHome "config.toml"

New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null

$tuiBlock = @"
[tui]
status_line = [
  "model-with-reasoning",
  "current-dir",
  "git-branch",
  "context-remaining",
  "five-hour-limit",
  "weekly-limit",
  "fast-mode",
]
status_line_use_colors = $((-not $NoColors).ToString().ToLowerInvariant())

"@

if (-not (Test-Path $ConfigPath)) {
    $tuiBlock | Set-Content -Path $ConfigPath -Encoding UTF8
}
else {
    $content = Get-Content -LiteralPath $ConfigPath -Raw
    $pattern = '(?ms)^\[tui\]\s.*?(?=^\[[^\]]+\]\s*$|\z)'
    if ([regex]::IsMatch($content, $pattern)) {
        $content = [regex]::Replace($content, $pattern, $tuiBlock.TrimEnd() + "`r`n`r`n", 1)
    }
    else {
        $firstSection = [regex]::Match($content, '(?m)^\[[^\]]+\]\s*$')
        if ($firstSection.Success) {
            $content = $content.Substring(0, $firstSection.Index).TrimEnd() + "`r`n`r`n" + $tuiBlock + $content.Substring($firstSection.Index).TrimStart()
        }
        else {
            $content = $content.TrimEnd() + "`r`n`r`n" + $tuiBlock
        }
    }
    Set-Content -LiteralPath $ConfigPath -Value $content -Encoding UTF8
}

if (-not $Quiet) {
    Write-Host "Codex TUI status line is enabled:"
    Write-Host "  $ConfigPath"
    Write-Host ""
    Write-Host "Segments:"
    Write-Host "  model, dir, git branch, context remaining, 5h limit, weekly limit, fast mode"
}
