#Requires -Version 5.1
#
# restore.ps1 / install.ps1 — установка SEO-центра из версионного архива на Windows.
#
# Работает в двух режимах:
#   1) Архив ещё упакован:
#        powershell -ExecutionPolicy Bypass -File restore.ps1 "C:\path\seo-center-HOST-VER.tar.gz.enc"
#   2) Архив уже распакован, запускается из его корня:
#        powershell -ExecutionPolicy Bypass -File restore.ps1
#
# Расшифровка .enc: сначала пробуем встроенными средствами .NET (OpenSSL-совместимый
# AES-256-CBC + PBKDF2-SHA256), при неудаче — через openssl (напр. из Git for Windows).
#
# Переносит: project/ -> проект, home/.config/opencode -> %USERPROFILE%\.config\opencode,
# home/.local/share/opencode/auth.json, home/.omniroute. systemd-юниты (Linux) пропускаются.
#
param(
  [Parameter(Position = 0)][string]$Archive = "",
  [string]$ProjectDir = "",
  [string]$Pass = "",
  [switch]$NoDeps
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Tar = Join-Path $env:SystemRoot "System32\tar.exe"
if (-not (Test-Path -LiteralPath $Tar)) { Write-Error "Не найден tar.exe (нужен Windows 10 1803+)."; exit 1 }
$HomeDir = $env:USERPROFILE
if (-not $ProjectDir) { $ProjectDir = Join-Path $HomeDir "SEO-центр" }

$TmpExtract = ""
$TmpDecrypt = ""
$TmpPass = ""
$cleanup = {
  foreach ($p in @($TmpDecrypt, $TmpPass)) { if ($p -and (Test-Path -LiteralPath $p)) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue } }
  if ($TmpExtract -and (Test-Path -LiteralPath $TmpExtract)) { Remove-Item -LiteralPath $TmpExtract -Recurse -Force -ErrorAction SilentlyContinue }
}

function Get-Passphrase {
  if ($Pass) { return $Pass }
  if ($env:SEO_CENTER_BACKUP_PASSPHRASE) { return $env:SEO_CENTER_BACKUP_PASSPHRASE }
  $pf = Join-Path $HomeDir ".config\opencode\seo-backup-pass"
  if (Test-Path -LiteralPath $pf) { return (Get-Content -LiteralPath $pf -Raw).Trim() }
  return ""
}

# Расшифровка OpenSSL-совместимого файла (.enc -> .tar.gz) без внешних утилит.
function Decrypt-OpenSslDotNet {
  param([string]$InPath, [string]$OutPath, [string]$Password)
  $bytes = [IO.File]::ReadAllBytes($InPath)
  if ($bytes.Length -lt 32) { throw "слишком короткий .enc" }
  $magic = [Text.Encoding]::ASCII.GetString($bytes, 0, 8)
  if ($magic -ne "Salted__") { throw "не OpenSSL-формат (нет заголовка Salted__)" }
  $salt = New-Object byte[] 8
  [Array]::Copy($bytes, 8, $salt, 0, 8)
  $ct = New-Object byte[] ($bytes.Length - 16)
  [Array]::Copy($bytes, 16, $ct, 0, $ct.Length)
  $kdf = New-Object System.Security.Cryptography.Rfc2898DeriveBytes(
    $Password, $salt, 200000, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
  $keyiv = $kdf.GetBytes(48)
  $key = New-Object byte[] 32; [Array]::Copy($keyiv, 0, $key, 0, 32)
  $iv  = New-Object byte[] 16; [Array]::Copy($keyiv, 32, $iv, 0, 16)
  $aes = [System.Security.Cryptography.Aes]::Create()
  $aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
  $aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
  $aes.KeySize = 256
  $aes.Key = $key; $aes.IV = $iv
  $dec = $aes.CreateDecryptor()
  $out = $dec.TransformFinalBlock($ct, 0, $ct.Length)
  [IO.File]::WriteAllBytes($OutPath, $out)
  $dec.Dispose(); $aes.Dispose(); $kdf.Dispose()
}

function Decrypt-WithOpenssl {
  param([string]$InPath, [string]$OutPath, [string]$Password)
  $openssl = Get-Command openssl -ErrorAction SilentlyContinue
  if (-not $openssl) { throw "openssl не найден" }
  $script:TmpPass = Join-Path $env:TEMP ("seo-pass-" + [guid]::NewGuid().ToString("N"))
  [IO.File]::WriteAllText($script:TmpPass, $Password, (New-Object System.Text.UTF8Encoding($false)))
  & $openssl.Source enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in $InPath -out $OutPath -pass "file:$TmpPass"
  if ($LASTEXITCODE -ne 0) { throw "openssl не смог расшифровать архив" }
}

function New-PreBackup {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $bak = "$($Path).before-$stamp"
  Write-Host "   (сохраняю предыдущую версию: $bak)"
  New-Item -ItemType Directory -Path (Split-Path -Parent $bak) -Force | Out-Null
  Move-Item -LiteralPath $Path -Destination $bak -Force
}

try {
  $Base = ""
  if ($Archive) {
    $Archive = (Resolve-Path -LiteralPath $Archive).Path
    $ToExtract = $Archive
    if ($Archive.ToLower().EndsWith(".enc")) {
      $pw = Get-Passphrase
      if (-not $pw) { throw "Нужна парольная фраза (-Pass ПАРОЛЬ или %USERPROFILE%\.config\opencode\seo-backup-pass)" }
      $TmpDecrypt = Join-Path $env:TEMP ("seo-center-dec-" + [guid]::NewGuid().ToString("N") + ".tar.gz")
      Write-Host "[[1/3]] Расшифровка архива…"
      try { Decrypt-OpenSslDotNet -InPath $Archive -OutPath $TmpDecrypt -Password $pw }
      catch {
        Write-Host "   .NET-расшифровка не удалась ($($_.Exception.Message)) — пробую openssl…"
        Decrypt-WithOpenssl -InPath $Archive -OutPath $TmpDecrypt -Password $pw
      }
      $ToExtract = $TmpDecrypt
    }
    $TmpExtract = Join-Path $env:TEMP ("seo-center-unpack-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $TmpExtract -Force | Out-Null
    Write-Host "[[2/3]] Распаковка архива…"
    & $Tar -xzf $ToExtract -C $TmpExtract
    if ($LASTEXITCODE -ne 0) { throw "tar не смог распаковать архив" }
    $Base = $TmpExtract
  } else {
    $Base = $PSScriptRoot
    if (-not (Test-Path -LiteralPath $Base)) { $Base = (Get-Location).Path }
  }

  if (-not (Test-Path -LiteralPath (Join-Path $Base "project"))) {
    throw "В архиве нет папки project/ — это не архив SEO-центра."
  }

  Write-Host "[[3/3]] Установка…"
  Write-Host "   Проект:  $ProjectDir"
  Write-Host "   Профиль: $HomeDir"

  # Проект
  $projSrc = Join-Path $Base "project"
  New-PreBackup $ProjectDir
  New-Item -ItemType Directory -Path $ProjectDir -Force | Out-Null
  & robocopy $projSrc $ProjectDir /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy не смог скопировать проект (код $LASTEXITCODE)" }

  # Глобальные настройки opencode
  $cfgSrc = Join-Path $Base "home\.config\opencode"
  if (Test-Path -LiteralPath $cfgSrc) {
    $cfgDst = Join-Path $HomeDir ".config\opencode"
    New-PreBackup $cfgDst
    New-Item -ItemType Directory -Path $cfgDst -Force | Out-Null
    & robocopy $cfgSrc $cfgDst /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
  }

  # auth.json
  $authSrc = Join-Path $Base "home\.local\share\opencode\auth.json"
  if (Test-Path -LiteralPath $authSrc) {
    $authDst = Join-Path $HomeDir ".local\share\opencode"
    New-Item -ItemType Directory -Path $authDst -Force | Out-Null
    Copy-Item -LiteralPath $authSrc -Destination (Join-Path $authDst "auth.json") -Force
  }

  # OmniRoute
  $omniSrc = Join-Path $Base "home\.omniroute"
  if (Test-Path -LiteralPath $omniSrc) {
    $omniDst = Join-Path $HomeDir ".omniroute"
    New-PreBackup $omniDst
    New-Item -ItemType Directory -Path $omniDst -Force | Out-Null
    & robocopy $omniSrc $omniDst /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
  }

  Write-Host ""
  Write-Host "Готово. Проект развёрнут в: $ProjectDir"
  Write-Host "Откройте эту папку в opencode и скажите «включи/запусти seo центр»."
  Write-Host "systemd-юниты в архив для Windows не применяются (они для Linux)."
  if (-not $NoDeps) {
    Write-Host "Зависимости (npm) на Windows ставятся по месту открытия проекта."
  }
}
finally {
  & $cleanup
}
