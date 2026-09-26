param($Port, [switch]$NoBrowser, [switch]$Lan, $LanPassword, [switch]$RemoteConsole, $PublicName)
if (-not $NoBrowser -or -not $Lan -or -not $RemoteConsole) { throw "Incorrect remote flags" }
if ($LanPassword -cnotmatch '^[0-9a-f]{36}$') { throw "Incorrect remote password" }
if ($Port -ne 41731 -or $PublicName -ne 'misao.local') { throw "Incorrect defaults" }
