#!/usr/bin/env bash
# Поднимает отдельный Chrome с копией профиля пользователя под Xvfb и CDP-портом.
# Профиль пользователя нужен, чтобы использовать уже выполненные входы
# (Google Таблицы, pr-cy, соцсети, каталоги).
#
# Использование:
#   scripts/browser-session.sh [PORT]        # запустить (по умолчанию 9222)
#   scripts/browser-session.sh stop [PORT]   # остановить
#
# Linux. Для macOS путь профиля: ~/Library/Application Support/Google/Chrome
# Для Windows: %LOCALAPPDATA%\Google\Chrome\User Data
set -euo pipefail

WORK="/tmp/opencode/competitor-audit-profile"
DISP=":99"

stop_all() {
  local port="$1" pids p pg xp
  pids=$(lsof -ti:"${port}" 2>/dev/null || true)
  for p in $pids; do
    pg=$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ' || true)
    [ -n "$pg" ] && kill -TERM -- "-$pg" 2>/dev/null || true
  done
  sleep 2
  pkill -f "user-data-dir=$WORK" 2>/dev/null || true
  xp=$(pgrep -x Xvfb 2>/dev/null || true)
  [ -n "$xp" ] && kill -TERM $xp 2>/dev/null || true
  echo "Остановлено (порт ${port}, Xvfb)."
}

if [ "${1:-}" = "stop" ]; then
  stop_all "${2:-9222}"
  exit 0
fi

PORT="${1:-9222}"
PROFILE_SRC="${CHROME_PROFILE:-$HOME/.config/google-chrome}"
if [ ! -d "$PROFILE_SRC" ]; then
  echo "Не найден профиль Chrome: $PROFILE_SRC (задай CHROME_PROFILE=...)" >&2
  exit 1
fi

mkdir -p "$WORK/Default/Network"
cp "$PROFILE_SRC/Local State" "$WORK/" 2>/dev/null || true
cp "$PROFILE_SRC/Default/Preferences" "$WORK/Default/" 2>/dev/null || true
cp "$PROFILE_SRC/Default/Cookies" "$WORK/Default/" 2>/dev/null || true
cp "$PROFILE_SRC/Default/Login Data" "$WORK/Default/" 2>/dev/null || true

if ! pgrep -x Xvfb >/dev/null 2>&1; then
  Xvfb "$DISP" -screen 0 1600x1200x24 >/tmp/opencode/competitor-audit-xvfb.log 2>&1 &
  sleep 2
fi

setsid env DISPLAY="$DISP" google-chrome \
  --remote-debugging-port="$PORT" \
  --remote-allow-origins='*' \
  --user-data-dir="$WORK" \
  --no-first-run --no-default-browser-check \
  about:blank >/tmp/opencode/competitor-audit-chrome.log 2>&1 &

sleep 8
if curl -s --max-time 5 "http://127.0.0.1:${PORT}/json/version" >/dev/null; then
  echo "Chrome запущен: CDP http://127.0.0.1:${PORT} (DISPLAY=${DISP})"
  echo "Профиль: $WORK"
else
  echo "Chrome не отвечает на порту ${PORT}, смотри /tmp/opencode/competitor-audit-chrome.log" >&2
  exit 1
fi
