# Установка зависимостей навыка audit-konkurentov (Windows)
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $PSScriptRoot
Push-Location $dir
try {
  Write-Host "Устанавливаю зависимости в $dir ..."
  if (Get-Command npm -ErrorAction SilentlyContinue) {
    npm install
    Write-Host "Готово."
  } else {
    Write-Host "npm не найден. Установи Node.js (>=18) и повтори."
    exit 1
  }
} finally {
  Pop-Location
}
