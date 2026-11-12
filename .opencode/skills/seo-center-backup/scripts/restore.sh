#!/usr/bin/env bash
#
# restore.sh / install.sh — установка SEO-центра из версионного архива.
#
# Работает в двух режимах:
#   1) Архив ещё упакован:
#        bash restore.sh /путь/seo-center-HOST-VERSION.tar.gz
#   2) Архив уже распакован, запускается install.sh из его корня:
#        bash install.sh
#
# Переносит проект, глобальные настройки opencode, auth-ключи, OmniRoute и
# systemd-сервисы, подставляя пути текущего пользователя, затем ставит
# зависимости и включает сервисы.
#
set -euo pipefail
umask 077

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARCHIVE=""
PROJECT_DIR=""
DO_SERVICES=1
DO_DEPS=1
DO_GIT=1
PASSPHRASE=""
PASS_FILE="$HOME/.config/opencode/seo-backup-pass"

usage() {
  cat <<'EOF'
Использование: install.sh [АРХИВ.tar.gz|.enc] [опции]

  АРХИВ.tar.gz      Путь к архиву бэкапа (если он ещё упакован).
  --project-dir DIR Куда развернуть проект (по умолчанию ~/Рабочий стол/opencode).
  --no-services     Не трогать systemd-сервисы.
  --no-deps         Не устанавливать npm-зависимости.
  --no-git          Не восстанавливать git-схему (ветки main/dev + worktree).
  --pass ПАРОЛЬ     Парольная фраза для зашифрованного архива (.enc).
  -h, --help        Показать эту справку.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project-dir) PROJECT_DIR="$2"; shift 2;;
    --no-services) DO_SERVICES=0;    shift;;
    --no-deps)     DO_DEPS=0;        shift;;
    --no-git)      DO_GIT=0;         shift;;
    --pass)        PASSPHRASE="$2";  shift 2;;
    -h|--help)     usage; exit 0;;
    -*)            echo "Неизвестный аргумент: $1" >&2; usage >&2; exit 1;;
    *)             ARCHIVE="$1";     shift;;
  esac
done

TMP_EXTRACT=""
TMP_DECRYPT=""
TMP_PASSFILE=""
cleanup() {
  [ -n "$TMP_EXTRACT" ] && rm -rf "$TMP_EXTRACT" || true
  [ -n "$TMP_DECRYPT" ] && rm -f "$TMP_DECRYPT" || true
  [ -n "$TMP_PASSFILE" ] && rm -f "$TMP_PASSFILE" || true
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Расшифровка архива (.enc) — AES-256 (openssl).
# ---------------------------------------------------------------------------
resolve_passphrase() {
  [ -n "$PASSPHRASE" ] && return 0
  if [ -n "${SEO_CENTER_BACKUP_PASSPHRASE:-}" ]; then
    PASSPHRASE="$SEO_CENTER_BACKUP_PASSPHRASE"; return 0
  fi
  if [ -f "$PASS_FILE" ]; then
    PASSPHRASE="$(cat "$PASS_FILE")"; return 0
  fi
  if [ -t 0 ]; then
    printf 'Введите парольную фразу для архива: ' >&2
    read -rs PASSPHRASE
    echo >&2
  fi
}

decrypt_archive() { # in out
  resolve_passphrase
  [ -n "$PASSPHRASE" ] || {
    echo "Архив зашифрован, но парольная фраза не задана." >&2
    echo "Укажите --pass ПАРОЛЬ или положите её в $PASS_FILE." >&2
    exit 1
  }
  TMP_PASSFILE="$(mktemp)"
  chmod 600 "$TMP_PASSFILE"
  printf '%s' "$PASSPHRASE" > "$TMP_PASSFILE"
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
        -in "$1" -out "$2" -pass "file:$TMP_PASSFILE" 2>/dev/null; then
    echo "Не удалось расшифровать архив — проверьте парольную фразу." >&2
    exit 1
  fi
}

BASE="$SELF_DIR"
if [ -n "$ARCHIVE" ]; then
  ARCHIVE="$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")"
  [ -f "$ARCHIVE" ] || { echo "Архив не найден: $ARCHIVE" >&2; exit 1; }
  TMP_EXTRACT="$(mktemp -d)"
  TO_EXTRACT="$ARCHIVE"
  # Зашифрованный архив: расшифровываем во временный .tar.gz.
  if [ "${ARCHIVE%.enc}" != "$ARCHIVE" ]; then
    echo "[[stage:1/5]] Расшифровка архива"
    TMP_DECRYPT="$(mktemp --suffix=.tar.gz)"
    decrypt_archive "$ARCHIVE" "$TMP_DECRYPT"
    TO_EXTRACT="$TMP_DECRYPT"
  fi
  echo "[[stage:1/5]] Распаковка архива"
  tar -xzf "$TO_EXTRACT" -C "$TMP_EXTRACT"
  BASE="$TMP_EXTRACT"
  if [ ! -f "$BASE/manifest.json" ]; then
    inner="$(find "$BASE" -maxdepth 2 -name manifest.json -print -quit)"
    [ -n "$inner" ] && BASE="$(dirname "$inner")"
  fi
fi

[ -f "$BASE/manifest.json" ] || {
  echo "Не найден manifest.json — это не архив SEO-центра." >&2
  exit 1
}
[ -d "$BASE/project" ] || { echo "В архиве нет папки project/." >&2; exit 1; }

get_manifest() { # key
  python3 - "$BASE/manifest.json" "$1" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    data = {}
print(data.get(sys.argv[2], ""))
PY
}

VERSION="$(get_manifest version)"
OMNIROUTE_VERSION="$(get_manifest omniroute_version)"

if [ -z "$PROJECT_DIR" ]; then
  if   [ -d "$HOME/Рабочий стол" ]; then PROJECT_DIR="$HOME/Рабочий стол/opencode"
  elif [ -d "$HOME/Desktop" ];       then PROJECT_DIR="$HOME/Desktop/opencode"
  else                                    PROJECT_DIR="$HOME/opencode"
  fi
fi

echo "Версия архива: ${VERSION:-неизвестна}"
echo "Проект будет установлен в: $PROJECT_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$HOME/seo-center-backups/pre-restore-$STAMP"

echo "[[stage:2/5]] Резервная копия текущей установки"
mkdir -p "$BACKUP_DIR"
if [ -d "$PROJECT_DIR" ]; then
  tar -C "$PROJECT_DIR" \
    --exclude='./node_modules' --exclude='*/node_modules' \
    --exclude='./seo-center-archives' \
    -czf "$BACKUP_DIR/project-before.tar.gz" . 2>/dev/null || true
fi
[ -d "$HOME/.config/opencode" ] && cp -a "$HOME/.config/opencode" "$BACKUP_DIR/config-opencode" 2>/dev/null || true
[ -f "$HOME/.local/share/opencode/auth.json" ] && \
  mkdir -p "$BACKUP_DIR/auth" && cp -a "$HOME/.local/share/opencode/auth.json" "$BACKUP_DIR/auth/" 2>/dev/null || true
[ -d "$HOME/.omniroute" ] && tar -C "$HOME/.omniroute" \
  --exclude='./logs' --exclude='./call_logs' \
  -czf "$BACKUP_DIR/omniroute-before.tar.gz" . 2>/dev/null || true
echo "Резервная копия: $BACKUP_DIR"

echo "[[stage:3/5]] Развёртывание файлов"
mkdir -p "$PROJECT_DIR"
# Git-репозиторий (если сохранён) разворачиваем ДО проекта: файлы рабочего
# дерева лягут поверх, а .git сохранится — получится готовый репозиторий main.
HAS_GIT=0
[ -d "$BASE/git" ] && [ "$DO_GIT" = 1 ] && HAS_GIT=1
if [ "$HAS_GIT" = 1 ]; then
  echo "  разворачиваю git-репозиторий (ветки main/dev)"
  tar -C "$BASE/git" -cf - . | tar -C "$PROJECT_DIR" -xf -
fi
tar -C "$BASE/project" -cf - . | tar -C "$PROJECT_DIR" -xf -

if [ -d "$BASE/home" ]; then
  ( cd "$BASE/home" && tar -cf - . ) | ( cd "$HOME" && tar -xf - )
fi

# ---------------------------------------------------------------------------
# Восстановление тестового контура из worktree (ветка dev).
# ---------------------------------------------------------------------------
WORKTREE_DIR=""
if [ "$HAS_GIT" = 1 ] && [ -d "$BASE/worktree" ]; then
  WORKTREE_DIR="$(dirname "$PROJECT_DIR")/seo-center-test"
  echo "  разворачиваю worktree dev: $WORKTREE_DIR"
  # Порядок: сначала регистрируем worktree через git (он создаёт рабочий каталог
  # из ветки dev), затем поверх кладём сохранённые файлы (включая .opencode-local,
  # если ветка их отслеживает). Так `git worktree add` не падает на непустом каталоге.
  if command -v git >/dev/null 2>&1; then
    # В .git остались метаданные worktree с исходного ПК (чужой абсолютный путь).
    rm -rf "$PROJECT_DIR/.git/worktrees" 2>/dev/null || true
    rm -rf "$WORKTREE_DIR" 2>/dev/null || true
    ( cd "$PROJECT_DIR" && git worktree add --force "$WORKTREE_DIR" dev \
        >/dev/null 2>&1 ) || echo "  ! не удалось подключить worktree (проверьте git вручную)"
  else
    mkdir -p "$WORKTREE_DIR"
  fi
  if [ -d "$WORKTREE_DIR" ]; then
    tar -C "$BASE/worktree" -cf - . | tar -C "$WORKTREE_DIR" -xf -
  fi
  # Симлинки на общий код/зависимости внутри worktree.
  [ -e "$WORKTREE_DIR/.opencode" ] || ln -sfn "$HOME/.opencode" "$WORKTREE_DIR/.opencode" 2>/dev/null || true
  [ -L "$WORKTREE_DIR/.opencode-local/node_modules" ] || [ -e "$WORKTREE_DIR/.opencode-local/node_modules" ] || \
    ln -sfn "$PROJECT_DIR/.opencode-local/node_modules" "$WORKTREE_DIR/.opencode-local/node_modules" 2>/dev/null || true
  [ -L "$WORKTREE_DIR/seo-panel/node_modules" ] || [ -e "$WORKTREE_DIR/seo-panel/node_modules" ] || \
    ln -sfn "$PROJECT_DIR/.opencode-local/node_modules" "$WORKTREE_DIR/seo-panel/node_modules" 2>/dev/null || true
fi

# Пути для systemd-юнитов.
NODE_BIN="$(command -v node 2>/dev/null || true)"
NODE_BIN_DIR=""
[ -n "$NODE_BIN" ] && NODE_BIN_DIR="$(dirname "$NODE_BIN")"
if [ -z "$NODE_BIN_DIR" ]; then
  NODE_BIN_DIR="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
fi
OPENCODE_BIN="$(command -v opencode 2>/dev/null || true)"
[ -z "$OPENCODE_BIN" ] && OPENCODE_BIN="$HOME/.opencode/bin/opencode"
OMNIROUTE_BIN="$(command -v omniroute 2>/dev/null || true)"
[ -z "$OMNIROUTE_BIN" ] && [ -n "$NODE_BIN_DIR" ] && OMNIROUTE_BIN="$NODE_BIN_DIR/omniroute"
[ -z "$OMNIROUTE_BIN" ] && OMNIROUTE_BIN="$HOME/.nvm/versions/node/v22.23.2/bin/omniroute"

render_units() {
  local dir="$HOME/.config/systemd/user" f
  for f in omniroute.service opencode-seo.service \
           opencode-seo-panel.service \
           opencode-seo-test.service opencode-seo-panel-test.service \
           opencode-seo-heartbeat.service opencode-seo-heartbeat.timer \
           opencode-seo-keepalive.sh geo-tracker.service; do
    [ -f "$dir/$f" ] || continue
    sed -i \
      -e "s|__PROJECT__|$PROJECT_DIR|g" \
      -e "s|__WORKTREE__|${WORKTREE_DIR:-$WORKTREE_DIR}|g" \
      -e "s|__NODE_BIN__|$NODE_BIN_DIR|g" \
      -e "s|__OPENCODE_BIN__|$OPENCODE_BIN|g" \
      -e "s|__OMNIROUTE_BIN__|$OMNIROUTE_BIN|g" \
      -e "s|__HOME__|$HOME|g" \
      "$dir/$f"
  done
  [ -f "$dir/opencode-seo-keepalive.sh" ] && chmod +x "$dir/opencode-seo-keepalive.sh" || true
}
render_units

echo "[[stage:4/5]] Зависимости"
if [ "$DO_DEPS" = 1 ]; then
  if command -v npm >/dev/null 2>&1; then
    for d in "$PROJECT_DIR" "$PROJECT_DIR/.opencode" "$PROJECT_DIR/.opencode-local" \
             "${WORKTREE_DIR:-/nonexistent}" "${WORKTREE_DIR:-/nonexistent}/.opencode-local" \
             "$PROJECT_DIR/geo-aeo-tracker" "$HOME/.config/opencode"; do
      [ -f "$d/package.json" ] || continue
      echo "  npm install → $d"
      ( cd "$d" && npm install --no-audit --no-fund ) || echo "  ! npm install не удалось в $d"
    done
    if [ -d "$PROJECT_DIR/geo-aeo-tracker" ]; then
      echo "  npm run build → geo-aeo-tracker"
      ( cd "$PROJECT_DIR/geo-aeo-tracker" && npm run build ) || echo "  ! сборка geo-aeo-tracker не удалась"
    fi
    ( cd "$PROJECT_DIR" && npx --yes playwright install chromium ) || echo "  ! playwright install не удался"
    if ! command -v omniroute >/dev/null 2>&1; then
      if [ -n "$OMNIROUTE_VERSION" ]; then
        npm install -g "omniroute@$OMNIROUTE_VERSION" \
          || npm install -g omniroute \
          || echo "  ! не удалось установить omniroute"
      else
        npm install -g omniroute || echo "  ! не удалось установить omniroute"
      fi
    fi
  else
    echo "  ! npm не найден — пропускаю установку зависимостей"
  fi
else
  echo "  пропущено (--no-deps)"
fi

echo "[[stage:5/5]] Сервисы"
if [ "$DO_SERVICES" = 1 ] && command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
  systemctl --user daemon-reload || true
  systemctl --user enable omniroute.service opencode-seo.service geo-tracker.service \
    opencode-seo-heartbeat.timer 2>/dev/null || true
  [ -n "$WORKTREE_DIR" ] && [ -d "$WORKTREE_DIR" ] && \
    systemctl --user enable opencode-seo-test.service opencode-seo-panel-test.service 2>/dev/null || true
  systemctl --user restart omniroute.service 2>/dev/null \
    || systemctl --user start omniroute.service 2>/dev/null || true
  systemctl --user restart opencode-seo.service 2>/dev/null \
    || systemctl --user start opencode-seo.service 2>/dev/null || true
  # Панель прода — отдельный процесс (если юнит есть).
  systemctl --user restart opencode-seo-panel.service 2>/dev/null \
    || systemctl --user start opencode-seo-panel.service 2>/dev/null || true
  # Тестовый контур (worktree dev) — включаем, если worktree восстановлен.
  if [ -n "$WORKTREE_DIR" ] && [ -d "$WORKTREE_DIR" ]; then
    systemctl --user restart opencode-seo-test.service 2>/dev/null \
      || systemctl --user start opencode-seo-test.service 2>/dev/null || true
    systemctl --user restart opencode-seo-panel-test.service 2>/dev/null \
      || systemctl --user start opencode-seo-panel-test.service 2>/dev/null || true
  fi
  systemctl --user start geo-tracker.service opencode-seo-heartbeat.timer 2>/dev/null || true
  echo "  сервисы включены и запущены"
else
  echo "  пропущено (нет user-systemd или указан --no-services)"
fi

echo
echo "Установка завершена. Версия: ${VERSION:-неизвестна}"
echo "Проект: $PROJECT_DIR"
echo "Панель SEO: http://localhost:4180/  (и http://<IP>:4180/ в сети)"
echo "OmniRoute API: http://localhost:20128/v1"
echo "Резервная копия прежней установки: $BACKUP_DIR"
echo
echo "Не забудьте: после переноса открыть папку проекта в opencode и, при"
echo "необходимости, войти в Яндекс для навыка Wordstat (--renew)."
