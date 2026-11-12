#Requires -Version 5.1
#
# backup.ps1 — Windows-порт backup.sh: сохранение SEO-центра в версионный .tar.gz.
#
# Повторяет структуру архива backup.sh:
#   project/  home/.config/opencode  home/.local/share/opencode/auth.json
#   home/.omniroute  home/.config/systemd/user  manifest.json  install.sh
#   RESTORE.md  checksums.sha256
#
# Использование:
#   powershell -ExecutionPolicy Bypass -File backup.ps1
#   powershell -ExecutionPolicy Bypass -File backup.ps1 -Light
#   powershell -ExecutionPolicy Bypass -File backup.ps1 -Project "D:\proj" -Out "D:\arch"
#
param(
  [string]$Project = "",
  [string]$Out     = "",
  [switch]$Light
)

$ErrorActionPreference = "Stop"

$ScriptDir = $PSScriptRoot
$SkillDir  = (Resolve-Path (Join-Path $ScriptDir "..")).Path
if (-not $Project) {
  $Project = (Resolve-Path (Join-Path $SkillDir "..\..\..")).Path
}
$Project = (Resolve-Path -LiteralPath $Project).Path
if (-not (Test-Path -LiteralPath (Join-Path $Project ".opencode"))) {
  Write-Error "Это не похоже на проект SEO-центра (нет .opencode): $Project"
  exit 1
}
if (-not $Out) {
  # Архивы кладём в проект «SEO-центр» (если он есть рядом), в отдельную папку.
  $backupHome = $Project
  $sib = Join-Path (Split-Path -Parent $Project) "SEO-центр"
  if (Test-Path -LiteralPath $sib) { $backupHome = $sib }
  $Out = Join-Path $backupHome "seo-center-archives"
}
New-Item -ItemType Directory -Path $Out -Force | Out-Null

$Version = Get-Date -Format "yyyyMMdd-HHmmss"
$HostName = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { "host" }
$Name     = "seo-center-$HostName-$Version"
$HomeDir = $env:USERPROFILE
$Tar     = Join-Path $env:SystemRoot "System32\tar.exe"

$Stage = Join-Path $env:TEMP ("seo-center-stage-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Stage -Force | Out-Null
trap { if ($Stage -and (Test-Path -LiteralPath $Stage)) { Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue } }

function Invoke-Robocopy {
  param([string]$Src, [string]$Dst, [string[]]$XD, [string[]]$XF)
  if (-not (Test-Path -LiteralPath $Src)) { return }
  New-Item -ItemType Directory -Path $Dst -Force | Out-Null
  $rcArgs = @($Src, $Dst, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1")
  if ($XD -and $XD.Count) { $rcArgs += "/XD"; $rcArgs += $XD }
  if ($XF -and $XF.Count) { $rcArgs += "/XF"; $rcArgs += $XF }
  & robocopy @rcArgs | Out-Null
  $code = $LASTEXITCODE
  if ($code -ge 8) { throw "robocopy не смог скопировать '$Src' (код $code)" }
}

$XDirCommon = @("node_modules", ".git", ".next", "out", "build", ".turbo",
                "seo-center-archives", ".playwright-mcp",
                "Cache", "Code Cache", "GrShaderCache", "GPUCache", "ShaderCache")
$XFileCommon = @("*.log", "*.tsbuildinfo", "*.mp4", "*.mp4.part",
                 "*.tar.gz", "seo-center-backup.zip", "*.pid")

Write-Host "[[stage:1/4]] Проект SEO-центра: $Project"
Invoke-Robocopy -Src $Project -Dst (Join-Path $Stage "project") -XD $XDirCommon -XF $XFileCommon
if ($Light) {
  foreach ($d in @("seo-results", "seo-content")) {
    $p = Join-Path $Stage "project\$d"
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
  }
}

Write-Host "[[stage:2/4]] Глобальные настройки, auth, OmniRoute, сервисы"
$configDst = Join-Path $Stage "home\.config\opencode"
$authDst   = Join-Path $Stage "home\.local\share\opencode"
New-Item -ItemType Directory -Path $configDst, $authDst -Force | Out-Null

Invoke-Robocopy -Src (Join-Path $HomeDir ".config\opencode") -Dst $configDst `
  -XD @("node_modules", ".git") -XF @()

$authSrc = Join-Path $HomeDir ".local\share\opencode\auth.json"
if (Test-Path -LiteralPath $authSrc) { Copy-Item -LiteralPath $authSrc -Destination $authDst -Force }

$omniSrc = Join-Path $HomeDir ".omniroute"
if (Test-Path -LiteralPath $omniSrc) {
  Invoke-Robocopy -Src $omniSrc -Dst (Join-Path $Stage "home\.omniroute") `
    -XD @("logs", "call_logs", "db_backups") -XF @("*.pid")
}

# systemd-юниты (на Windows обычно отсутствуют). Пути заменяем на плейсхолдеры.
$unitSrc = Join-Path $HomeDir ".config\systemd\user"
if (Test-Path -LiteralPath $unitSrc) {
  $unitDst = Join-Path $Stage "home\.config\systemd\user"
  New-Item -ItemType Directory -Path $unitDst -Force | Out-Null
  $units = @("omniroute.service", "opencode-seo.service",
             "opencode-seo-heartbeat.service", "opencode-seo-heartbeat.timer",
             "opencode-seo-keepalive.sh", "geo-tracker.service")
  $escProject = [regex]::Escape($Project)
  $escHome    = [regex]::Escape($HomeDir)
  foreach ($f in $units) {
    $src = Join-Path $unitSrc $f
    if (-not (Test-Path -LiteralPath $src)) { continue }
    $txt = Get-Content -LiteralPath $src -Raw
    $txt = $txt -replace $escProject, "__PROJECT__"
    $txt = $txt -replace ("$escHome/\.nvm/versions/node/[^/]*/bin/omniroute"), "__OMNIROUTE_BIN__"
    $txt = $txt -replace ("$escHome/\.nvm/versions/node/[^/]*/bin"), "__NODE_BIN__"
    $txt = $txt -replace ("$escHome/\.opencode/bin/opencode"), "__OPENCODE_BIN__"
    $txt = $txt -replace $escHome, "__HOME__"
    [IO.File]::WriteAllText((Join-Path $unitDst $f), $txt, (New-Object System.Text.UTF8Encoding($false)))
  }
}

$OmniRouteVersion = ""
$omniCmd = Get-Command omniroute -ErrorAction SilentlyContinue
if ($omniCmd) {
  try { $OmniRouteVersion = ((& $omniCmd.Source --version 2>$null) -join "").Trim() } catch { $OmniRouteVersion = "" }
}

Write-Host "[[stage:3/4]] Манифест и контрольные суммы"
$manifest = [ordered]@{
  name              = "seo-center"
  version           = $Version
  created_at        = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK")
  hostname          = $HostName
  created_by        = $env:USERNAME
  source_project    = $Project
  omniroute_version = $OmniRouteVersion
  light             = [bool]$Light
  contents          = @("project", "home/.config/opencode", "home/.local/share/opencode/auth.json",
                       "home/.omniroute", "home/.config/systemd/user")
}
[IO.File]::WriteAllText((Join-Path $Stage "manifest.json"),
  ($manifest | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))

$installDst = Join-Path $Stage "install.sh"
Copy-Item -LiteralPath (Join-Path $ScriptDir "restore.sh") -Destination $installDst -Force
$restorePs1 = Join-Path $ScriptDir "restore.ps1"
if (Test-Path -LiteralPath $restorePs1) {
  Copy-Item -LiteralPath $restorePs1 -Destination (Join-Path $Stage "restore.ps1") -Force
}

$restoreMd = @"
# Установка SEO-центра

## Windows (Windows 10 1803+ — есть встроенный tar.exe)
1. Из папки с распакованным архивом:
   powershell -ExecutionPolicy Bypass -File restore.ps1
   Или сразу из зашифрованного архива:
   powershell -ExecutionPolicy Bypass -File restore.ps1 "C:\path\seo-center-*.tar.gz.enc" -Pass ПАРОЛЬ
2. Полезные ключи: -ProjectDir "D:\SEO-центр", -Pass ПАРОЛЬ.

## Linux / macOS
1. Распакуйте архив (если зашифрован — установщик расшифрует сам):
   bash install.sh /путь/seo-center-*.tar.gz.enc
2. Или вручную: tar -xzf seo-center-*.tar.gz -C /tmp/seo-center && bash /tmp/seo-center/install.sh
   (или откройте папку в opencode и скажите «распакуй seo центр»)

Ключи: --project-dir DIR, --no-services, --no-deps.
"@
[IO.File]::WriteAllText((Join-Path $Stage "RESTORE.md"), $restoreMd, (New-Object System.Text.UTF8Encoding($false)))

$stageLen = $Stage.Length + 1
$lines = Get-ChildItem -LiteralPath $Stage -Recurse -File -Force |
  Where-Object { $_.Name -ne "checksums.sha256" } |
  ForEach-Object {
    $rel = $_.FullName.Substring($stageLen) -replace '\\', '/'
    "{0}  ./{1}" -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower(), $rel
  } | Sort-Object
[IO.File]::WriteAllLines((Join-Path $Stage "checksums.sha256"), $lines, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "[[stage:4/4]] Упаковка архива"
$archive = Join-Path $Out "$Name.tar.gz"
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
& $Tar -C $Stage -czf $archive .
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $archive)) { Write-Error "tar не смог создать архив"; exit 1 }
Copy-Item -LiteralPath $archive -Destination (Join-Path $Out "latest.tar.gz") -Force

$size  = "{0:N1} MB" -f ((Get-Item -LiteralPath $archive).Length / 1MB)
$count = (Get-ChildItem -LiteralPath $Stage -Recurse -File -Force | Measure-Object).Count
Write-Host ""
Write-Host "Готово: $archive"
Write-Host "Версия: $Version | файлов: $count | размер: $size"
Write-Host "Копия:  $Out\latest.tar.gz"
Write-Host ""
Write-Host "ВНИМАНИЕ: архив содержит ключи доступа (opencode auth, OmniRoute)."
Write-Host "Храните и передавайте его только по защищённым каналам."
Write-Host "ARCHIVE_PATH=$archive"

Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
