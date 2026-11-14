#!/usr/bin/env bash
#
# backup.sh — сохранение всего SEO-центра в версионный архив.
#
# Собирает в один .tar.gz:
#   - проект SEO-центра (навыки, плагин, конфиги, данные),
#   - глобальные настройки opencode (~/.config/opencode, auth-ключи),
#   - OmniRoute (провайдеры, ключи, storage.sqlite),
#   - systemd-сервисы SEO-центра.
# Архив самодостаточен: содержит install.sh для установки на другом ПК.
#
# БЕЗОПАСНОСТЬ (по умолчанию):
#   - архив шифруется AES-256 (openssl) и получает расширение .tar.gz.enc;
#   - парольная фраза берётся из --pass, переменной SEO_CENTER_BACKUP_PASSPHRASE
#     или файла ~/.config/opencode/seo-backup-pass (создаётся автоматически, 600);
#   - права архива — 600, папки архивов — 700.
#   Отключить шифрование: --no-encrypt (не рекомендуется).
#   Архив без ключей/сессий для передачи коллегам: --no-secrets.
#
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_PROJECT="$(cd "$SKILL_DIR/../../.." && pwd)"

PROJECT_DIR="$DEFAULT_PROJECT"
OUT_DIR=""
LIGHT=0
ENCRYPT=1
NO_SECRETS=0
NO_GIT=0
PASSPHRASE=""
PASS_FILE="$HOME/.config/opencode/seo-backup-pass"

usage() {
  cat <<'EOF'
Использование: backup.sh [опции]

  --project DIR   Папка проекта SEO-центра (по умолчанию — корень проекта).
  --out DIR       Куда положить архив (по умолчанию <проект>/seo-center-archives).
  --light         Лёгкий архив: без рабочих результатов (seo-results, seo-content).
  --no-git        Не включать git-репозиторий и worktree (ветки main/dev).
  --no-secrets    Не включать ключи/сессии (для передачи сторонним лицам).
  --no-encrypt    Не шифровать архив (по умолчанию AES-256).
  --pass PASS     Парольная фраза шифрования (иначе env SEO_CENTER_BACKUP_PASSPHRASE
                  или файл ~/.config/opencode/seo-backup-pass).
  -h, --help      Показать эту справку.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT_DIR="$2"; shift 2;;
    --out)     OUT_DIR="$2";     shift 2;;
    --light)   LIGHT=1;          shift;;
    --no-git)  NO_GIT=1;         shift;;
    --no-secrets) NO_SECRETS=1;  shift;;
    --no-encrypt) ENCRYPT=0;     shift;;
    --pass)    PASSPHRASE="$2";  shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Неизвестный аргумент: $1" >&2; usage >&2; exit 1;;
  esac
done

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
# .opencode может быть симлинком на реальный проект (единый источник правды).
[ -e "$PROJECT_DIR/.opencode" ] || {
  echo "Это не похоже на проект SEO-центра (нет .opencode): $PROJECT_DIR" >&2
  exit 1
}

# Архивы сохраняем в проект «SEO-центр» (если он есть рядом с проектом скилла),
# в отдельную папку seo-center-archives. Иначе — в текущий проект.
BACKUP_HOME="$PROJECT_DIR"
_sibling="$(dirname "$PROJECT_DIR")/SEO-центр"
[ -d "$_sibling" ] && BACKUP_HOME="$_sibling"
OUT_DIR="${OUT_DIR:-$BACKUP_HOME/seo-center-archives}"
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Парольная фраза шифрования.
# ---------------------------------------------------------------------------
resolve_passphrase() {
  [ -n "$PASSPHRASE" ] && return 0
  if [ -n "${SEO_CENTER_BACKUP_PASSPHRASE:-}" ]; then
    PASSPHRASE="$SEO_CENTER_BACKUP_PASSPHRASE"; return 0
  fi
  if [ -f "$PASS_FILE" ]; then
    PASSPHRASE="$(cat "$PASS_FILE")"; return 0
  fi
  mkdir -p "$(dirname "$PASS_FILE")"
  chmod 700 "$(dirname "$PASS_FILE")" 2>/dev/null || true
  PASSPHRASE="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 36)"
  ( umask 077; printf '%s' "$PASSPHRASE" > "$PASS_FILE" )
  chmod 600 "$PASS_FILE" 2>/dev/null || true
  echo "Создан файл с парольной фразой: $PASS_FILE"
}

VERSION="$(date +%Y%m%d-%H%M%S)"
HOST="$(hostname -s 2>/dev/null || hostname)"
NAME="seo-center-${HOST}-${VERSION}"
STAGE="$(mktemp -d)"
ENC_TMP=""
cleanup() { rm -rf "$STAGE"; [ -n "$ENC_TMP" ] && rm -f "$ENC_TMP" || true; }
trap cleanup EXIT

echo "[[stage:1/4]] Проект SEO-центра: $PROJECT_DIR"
mkdir -p "$STAGE/project"
TAR_EXCLUDES=(
  --exclude='./node_modules'      --exclude='*/node_modules'
  --exclude='./.git'              --exclude='*/.git'
  --exclude='./.next'             --exclude='*/.next'
  --exclude='./out'               --exclude='*/out'
  --exclude='./build'             --exclude='*/build'
  --exclude='./.turbo'            --exclude='*/.turbo'
  --exclude='./seo-center-archives'
  --exclude='./.playwright-mcp'
  --exclude='*.log'
  --exclude='*.tsbuildinfo'
)
if [ "$LIGHT" = 1 ]; then
  TAR_EXCLUDES+=(--exclude='./seo-results' --exclude='./seo-content')
fi
if [ "$NO_SECRETS" = 1 ]; then
  # Секреты и персональные сессии — не попадают в «передаваемый» архив.
  TAR_EXCLUDES+=(
    --exclude='*/pw-profile' --exclude='*/pw-profile/*'
    --exclude='*/api-session.json'
    --exclude='*/.env' --exclude='*/.env.*'
    --exclude='*.key' --exclude='*.pem'
    --exclude='*/brand-context' --exclude='*/brand-context/*'
    --exclude='*/seo-cache' --exclude='*/seo-cache/*'
  )
fi
# -h (--dereference): если .opencode — симлинк на реальный проект, кладём в архив
# содержимое, а не сам симлинк (иначе бэкап был бы пустым по плагину/навыкам).
tar -h -C "$PROJECT_DIR" "${TAR_EXCLUDES[@]}" -cf - . | tar -C "$STAGE/project" -xf -

# ---------------------------------------------------------------------------
# Git-состояние и worktree. Проект живёт в git с ветками main (прод) и dev
# (тест). Тест-контур обслуживается из отдельного worktree (обычно
# ../seo-center-test). Обычный tar проекта их не захватывает (.git исключён,
# worktree лежит вне проекта), поэтому сохраняем их отдельно.
# Отключить: --no-git.
# ---------------------------------------------------------------------------
GIT_ENABLED=0
WORKTREE_PATH=""
if [ "$NO_GIT" = 0 ] && command -v git >/dev/null 2>&1 && \
   git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  GIT_ENABLED=1
  mkdir -p "$STAGE/git"
  # 1) Полный бэкап репозитория вместе со служебными файлами (.git).
  #    Восстановление: скопировать перед проектом → рабочее дерево main.
  tar -C "$PROJECT_DIR" -cf - --exclude='./node_modules' --exclude='*/node_modules' \
      --exclude='./seo-results' --exclude='./seo-results-test' \
      --exclude='./seo-center-archives' --exclude='./.playwright-mcp' \
      . | tar -C "$STAGE/git" -xf -
  # 2) Worktree ветки dev (если есть) — отдельным каталогом.
  #    Путь может содержать пробелы, поэтому берём строку после "worktree "
  #    целиком (POSIX-awk не поддерживает суффиксные группы как GNU).
  WORKTREE_PATH="$(git -C "$PROJECT_DIR" worktree list --porcelain 2>/dev/null \
      | sed -n 's/^worktree //p' | grep -v "^${PROJECT_DIR}$" | head -1 || true)"
  if [ -n "$WORKTREE_PATH" ] && [ -d "$WORKTREE_PATH" ]; then
    mkdir -p "$STAGE/worktree"
    tar -C "$WORKTREE_PATH" -cf - --exclude='./node_modules' --exclude='*/node_modules' \
        --exclude='./seo-results' --exclude='./seo-results-test' \
        --exclude='./seo-center-archives' --exclude='./.playwright-mcp' \
        . | tar -C "$STAGE/worktree" -xf -
    echo "  git: ветки $(git -C "$PROJECT_DIR" branch --format='%(refname:short)' | tr '\n' ' '); worktree: $WORKTREE_PATH"
  else
    echo "  git: ветки $(git -C "$PROJECT_DIR" branch --format='%(refname:short)' | tr '\n' ' '); worktree не найден"
  fi
fi

echo "[[stage:2/4]] Глобальные настройки, auth, OmniRoute, сервисы"
mkdir -p "$STAGE/home/.config/opencode" \
         "$STAGE/home/.local/share/opencode" \
         "$STAGE/home/.config/systemd/user"

copy_one() { # src dst
  [ -e "$1" ] || return 0
  mkdir -p "$(dirname "$2")"
  cp -a "$1" "$2"
}

copy_one "$HOME/.config/opencode/opencode.jsonc"        "$STAGE/home/.config/opencode/"
copy_one "$HOME/.config/opencode/opencode.json"         "$STAGE/home/.config/opencode/"
copy_one "$HOME/.config/opencode/package.json"          "$STAGE/home/.config/opencode/"
copy_one "$HOME/.config/opencode/package-lock.json"     "$STAGE/home/.config/opencode/"
copy_one "$HOME/.config/opencode/skills"                "$STAGE/home/.config/opencode/"

if [ "$NO_SECRETS" = 0 ]; then
  copy_one "$HOME/.config/opencode/seo-center-auth.json"  "$STAGE/home/.config/opencode/"
  copy_one "$HOME/.config/opencode/yandex-oauth.json"     "$STAGE/home/.config/opencode/"
  copy_one "$HOME/.local/share/opencode/auth.json"        "$STAGE/home/.local/share/opencode/"

  # OmniRoute: данные провайдеров и ключи (без логов и бэкапов БД).
  if [ -d "$HOME/.omniroute" ]; then
    mkdir -p "$STAGE/home/.omniroute"
    tar -C "$HOME/.omniroute" \
      --exclude='./logs' --exclude='./call_logs' --exclude='./db_backups' \
      --exclude='*.pid' \
      -cf - . | tar -C "$STAGE/home/.omniroute" -xf -
  fi
else
  echo "  (--no-secrets: ключи, сессии и бренд-контекст исключены)"
fi

# systemd-юниты: абсолютные пути заменяем на плейсхолдеры, чтобы перенос
# работал при другом имени пользователя и версии Node.js.
render_unit() { # src dst
  sed \
    -e "s|$PROJECT_DIR|__PROJECT__|g" \
    ${WORKTREE_PATH:+-e "s|$WORKTREE_PATH|__WORKTREE__|g"} \
    -e "s|$HOME/.nvm/versions/node/[^/]*/bin/omniroute|__OMNIROUTE_BIN__|g" \
    -e "s|$HOME/.nvm/versions/node/[^/]*/bin|__NODE_BIN__|g" \
    -e "s|$HOME/.opencode/bin/opencode|__OPENCODE_BIN__|g" \
    -e "s|$HOME|__HOME__|g" \
    "$1" > "$2"
}
for f in omniroute.service opencode-seo.service \
         opencode-seo-panel.service \
         opencode-seo-test.service opencode-seo-panel-test.service \
         opencode-seo-heartbeat.service opencode-seo-heartbeat.timer \
         opencode-seo-keepalive.sh geo-tracker.service; do
  if [ -f "$HOME/.config/systemd/user/$f" ]; then
    render_unit "$HOME/.config/systemd/user/$f" "$STAGE/home/.config/systemd/user/$f"
    chmod --reference="$HOME/.config/systemd/user/$f" "$STAGE/home/.config/systemd/user/$f" 2>/dev/null || true
  fi
done

OMNIROUTE_VERSION=""
if command -v omniroute >/dev/null 2>&1; then
  OMNIROUTE_VERSION="$(omniroute --version 2>/dev/null | tr -d '[:space:]' || true)"
fi

echo "[[stage:3/4]] Манифест и контрольные суммы"
export M_VERSION="$VERSION" M_HOST="$HOST" M_PROJECT="$PROJECT_DIR" \
       M_OMNIROUTE="$OMNIROUTE_VERSION" M_LIGHT="$LIGHT" \
       M_NO_SECRETS="$NO_SECRETS" M_ENCRYPTED="$ENCRYPT" \
       M_GIT="$GIT_ENABLED" M_WORKTREE="$WORKTREE_PATH"
export M_DATE="$(date -Iseconds)"
python3 - "$STAGE/manifest.json" <<'PY'
import json, os, sys
man = {
    "name": "seo-center",
    "version": os.environ["M_VERSION"],
    "created_at": os.environ["M_DATE"],
    "hostname": os.environ["M_HOST"],
    "created_by": os.environ.get("USER", ""),
    "source_project": os.environ["M_PROJECT"],
    "omniroute_version": os.environ["M_OMNIROUTE"],
    "light": os.environ["M_LIGHT"] == "1",
    "no_secrets": os.environ["M_NO_SECRETS"] == "1",
    "encrypted": os.environ["M_ENCRYPTED"] == "1",
    "git": os.environ["M_GIT"] == "1",
    "worktree": os.environ.get("M_WORKTREE", ""),
    "contents": ["project", "home/.config/opencode", "home/.local/share/opencode",
                 "home/.omniroute", "home/.config/systemd/user"],
    "analytics_state": [".runs.json", ".issues.json", ".insights.json", ".queue.json"],
}
if man["git"]:
    man["contents"].append("git (ветки main/dev + .git)")
if man["worktree"]:
    man["contents"].append("worktree (ветка dev, тест-контур)")
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump(man, f, ensure_ascii=False, indent=2)
PY

cp "$SCRIPT_DIR/restore.sh" "$STAGE/install.sh"
chmod +x "$STAGE/install.sh"
# Windows-установщик — кладём в архив, чтобы он разворачивался и на Windows.
if [ -f "$SCRIPT_DIR/restore.ps1" ]; then
  cp "$SCRIPT_DIR/restore.ps1" "$STAGE/restore.ps1"
fi
cat > "$STAGE/RESTORE.md" <<'EOF'
# Установка SEO-центра

## Linux / macOS
1. Распакуйте архив (если он зашифрован — установщик расшифрует сам):
   bash install.sh /путь/seo-center-*.tar.gz.enc
2. Или распакуйте вручную и запустите:
   tar -xzf seo-center-*.tar.gz -C /tmp/seo-center && bash /tmp/seo-center/install.sh
   (или просто откройте папку в opencode и скажите «распакуй seo центр»)

Полезные ключи: --project-dir DIR, --no-services, --no-deps,
--pass ПАРОЛЬ (для зашифрованного архива).

## Windows (PowerShell 5.1+, Windows 10 1803+ — есть встроенный tar.exe)
1. Из папки с архивом:
   powershell -ExecutionPolicy Bypass -File restore.ps1 "C:\path\seo-center-*.tar.gz.enc"
   (restore.ps1 лежит ВНУТРИ архива; можно также распаковать архив вручную и запустить
    powershell -ExecutionPolicy Bypass -File restore.ps1 из его корня)
2. Ключи: -ProjectDir "D:\SEO-центр", -Pass ПАРОЛЬ.
   Расшифровка .enc идёт встроенными средствами .NET; если не выйдет — нужен openssl
   (например, из Git for Windows).

Формат .tar.gz открывается и на Windows (tar.exe / Проводник в Windows 11),
и на Linux — архив не привязан к ОС.
EOF

( cd "$STAGE" && find . -type f ! -name checksums.sha256 -print0 \
    | sort -z | xargs -0 sha256sum > checksums.sha256 )

echo "[[stage:4/4]] Упаковка архива"
ARCHIVE="$OUT_DIR/$NAME.tar.gz"
tar -C "$STAGE" -czf "$ARCHIVE" .
chmod 600 "$ARCHIVE" 2>/dev/null || true

FINAL_ARCHIVE="$ARCHIVE"
if [ "$ENCRYPT" = 1 ]; then
  resolve_passphrase
  ENC_TMP="$(mktemp)"
  chmod 600 "$ENC_TMP"
  printf '%s' "$PASSPHRASE" > "$ENC_TMP"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -in "$ARCHIVE" -out "$ARCHIVE.enc" -pass "file:$ENC_TMP"
  chmod 600 "$ARCHIVE.enc" 2>/dev/null || true
  rm -f "$ARCHIVE"
  FINAL_ARCHIVE="$ARCHIVE.enc"
fi

rm -f "$OUT_DIR/latest.tar.gz" "$OUT_DIR/latest.tar.gz.enc"
ln -sf "$(basename "$FINAL_ARCHIVE")" "$OUT_DIR/latest.tar.gz.enc"
[ "$ENCRYPT" = 0 ] && ln -sf "$(basename "$FINAL_ARCHIVE")" "$OUT_DIR/latest.tar.gz"

SIZE="$(du -h "$FINAL_ARCHIVE" | cut -f1)"
COUNT="$(find "$STAGE" -type f | wc -l)"
echo
echo "Готово: $FINAL_ARCHIVE"
echo "Версия: $VERSION | файлов: $COUNT | размер: $SIZE | шифрование: $([ "$ENCRYPT" = 1 ] && echo 'AES-256' || echo 'выключено')"
echo
if [ "$GIT_ENABLED" = 1 ]; then
  echo "Git-состояние: сохранены репозиторий (ветки main/dev) и worktree."
  echo "При восстановлении схема dev/test/promote разворачивается автоматически."
fi
if [ "$ENCRYPT" = 1 ]; then
  echo "ВНИМАНИЕ: архив зашифрован. Парольная фраза хранится в $PASS_FILE"
  echo "и НЕ входит в архив. Сохраните её отдельно — без неё архив не открыть."
  if [ "$NO_SECRETS" = 0 ]; then
    echo "Архив содержит ключи доступа: передавайте только по защищённым каналам."
  fi
else
  echo "ВНИМАНИЕ: шифрование отключено (--no-encrypt)."
  if [ "$NO_SECRETS" = 0 ]; then
    echo "Архив содержит ключи доступа — храните и передавайте только по защищённым каналам."
  fi
fi
echo "ARCHIVE_PATH=$FINAL_ARCHIVE"
