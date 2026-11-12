#!/usr/bin/env bash
# Установка зависимостей навыка audit-konkurentov (Linux/macOS)
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
echo "Устанавливаю зависимости в $DIR ..."
npm install
echo "Готово."
