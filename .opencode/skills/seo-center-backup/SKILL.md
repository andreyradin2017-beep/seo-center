---
name: seo-center-backup
description: Сохраняет и переносит весь SEO-центр opencode одним действием — делает версионный архив проекта (.opencode, навыки, плагин, конфиги, auth-ключи, OmniRoute, systemd-сервисы) и восстанавливает его на другом ПК. Use when the user says "сохрани seo центр", "сохрани сео центр", "бэкап seo центра", "сделай архив seo центра", "сохрани проект seo центра", "перенеси seo центр", "обнови seo центр", "синхронизируй seo центр", "распакуй seo центр", "установи seo центр", "seo-backup", "seo center backup", or asks to save/transfer/restore the SEO center between computers.
---

# Навык: сохранение и перенос SEO-центра

Навык упаковывает **весь SEO-центр** в один версионный `.tar.gz` и умеет
разворачивать его на другой машине со всеми навыками, настройками, ключами,
OmniRoute и systemd-сервисами.

## Когда что запускать

Определи режим по запросу пользователя:

| Запрос пользователя | Действие |
| --- | --- |
| «сохрани seo центр», «сделай бэкап/архив», «обнови версию», «синхронизируй» | **Сохранение** → `scripts/backup.sh` |
| «распакуй seo центр», «установи из архива», «перенеси на этот ПК» | **Восстановление** → `scripts/restore.sh` |

## Сохранение

Выполни из корня проекта:

```bash
bash .opencode/skills/seo-center-backup/scripts/backup.sh
```

Скрипт сам находит корень проекта (навык лежит в `.opencode/skills/`).

Архивы сохраняются в проект **`SEO-центр`** в отдельную папку `seo-center-archives/`
(если проект `SEO-центр` есть рядом; иначе — в текущий проект). Если `.opencode`
в проекте — симлинк на реальный проект, содержимое архивируется через `--dereference`
(в бэкап попадают сами плагин/навыки, а не ссылка).

Полезные ключи:

- `--out DIR` — куда положить архив (по умолчанию — `<проект SEO-центр>/seo-center-archives`; если рядом с проектом скилла есть проект `SEO-центр`, архивы сохраняются в него, в отдельную папку `seo-center-archives`).
- `--light` — без тяжёлых рабочих результатов (`seo-results/`, `seo-content/`).
- `--no-git` — не включать git-репозиторий и worktree (ветки `main`/`dev`).
- `--no-secrets` — не включать ключи, сессии, бренд-контекст (для передачи сторонним лицам).
- `--no-encrypt` — не шифровать архив (по умолчанию — шифрование AES-256).
- `--pass ПАРОЛЬ` — задать парольную фразу шифрования.
- `--project DIR` — если проект лежит не в корне навыка.

Результат: **`seo-center-<хост>-<YYYYMMDD-HHMMSS>.tar.gz.enc`** (зашифрованный)
+ симлинк `latest.tar.gz.enc` в `seo-center-archives/`. Скрипт печатает
`ARCHIVE_PATH=...` — покажи его пользователю.

Шифрование: архив шифруется AES-256 (openssl, PBKDF2). Парольная фраза берётся
из `--pass`, переменной `SEO_CENTER_BACKUP_PASSPHRASE` или файла
`~/.config/opencode/seo-backup-pass` (создаётся автоматически при первом запуске,
права 600). **Парольная фраза в архив не входит** — храни её отдельно, без неё
архив не открыть. Отключить шифрование: `--no-encrypt`.

Что попадает в архив:

- проект: `.opencode/` (навыки, плагин `seo-ui.ts`, `bg.png`, brand-context),
  `opencode.json`, `AGENTS.md`, `package.json`, `README.md`, рабочие данные;
- `~/.config/opencode/` (глобальный конфиг, `seo-center-auth.json`);
- `~/.local/share/opencode/auth.json` (ключи провайдеров opencode);
- `~/.omniroute/` (провайдеры, ключи, `storage.sqlite`, `.env`) без логов;
- systemd-сервисы: `omniroute`, `opencode-seo`, `opencode-seo-panel`,
  `opencode-seo-test`, `opencode-seo-panel-test`, `opencode-seo-heartbeat`,
  `geo-tracker` и `opencode-seo-keepalive.sh`;
- **git-состояние** (отдельный раздел `git/`): репозиторий с ветками `main`
  (прод) и `dev` (тест) вместе с `.git`;
- **worktree** тест-контура (отдельный раздел `worktree/`): копия каталога
  `../seo-center-test` (ветка `dev`);
- `install.sh` + `manifest.json` + `checksums.sha256` для установки и проверки.

Не включаются: `node_modules`, `.next`, кэши, старые архивы, логи, результаты
аудитов (`seo-results/`, `seo-results-test/`) — при `--light` они также исключены.

## Восстановление

Если архив ещё упакован:

```bash
bash .opencode/skills/seo-center-backup/scripts/restore.sh /путь/seo-center-*.tar.gz
```

Если архив уже распакован — запусти `install.sh` из его корня:

```bash
bash install.sh
```

Ключи: `--project-dir DIR`, `--no-services`, `--no-deps`, `--no-git`.

Если архив собран с git-состоянием, установщик:
1. восстанавливает репозиторий (ветки `main`/`dev`) в основную папку проекта;
2. создаёт worktree `../seo-center-test` из ветки `dev` (тестовый контур);
3. подключает тест-юниты `opencode-seo-test` / `opencode-seo-panel-test`
   (сначала `systemctl --user daemon-reload` и `enable`, затем запуск).

### Windows

Из папки с распакованным архивом (внутри есть `restore.ps1`):

```powershell
powershell -ExecutionPolicy Bypass -File restore.ps1
```

Или сразу из зашифрованного архива:

```powershell
powershell -ExecutionPolicy Bypass -File restore.ps1 "C:\path\seo-center-*.tar.gz.enc" -Pass ПАРОЛЬ
```

Ключи: `-ProjectDir DIR`, `-Pass ПАРОЛЬ`. Расшифровка `.enc` — встроенными средствами
.NET (OpenSSL-совместимо); при неудаче нужен `openssl` (например, из Git for Windows).
systemd-юниты (Linux) на Windows пропускаются; зависимости ставятся по месту открытия проекта.

Установщик (`install.sh` — Linux/macOS):

1. делает резервную копию текущей установки в `~/seo-center-backups/pre-restore-<дата>/`;
2. разворачивает проект (по умолчанию `~/Рабочий стол/opencode`, иначе `~/Desktop/opencode`);
3. копирует глобальные настройки, auth и `~/.omniroute`;
4. подставляет пути текущего пользователя и версии Node в systemd-юниты;
5. ставит зависимости (`npm install`, `playwright install chromium`, `omniroute`);
6. включает и запускает сервисы.

## Версии и синхронизация между ПК

- Каждый запуск создаёт новый архив с версией-таймстампом и `manifest.json`.
- Симлинк `latest.tar.gz` указывает на последний архив.
- Обновление/синхронизация: сделать бэкап на исходной машине → перенести файл →
  на целевой запустить `restore.sh <архив>`. Установщик перезапишет файлы, но
  сначала сохранит прежнюю версию в `~/seo-center-backups/`.
- Сверка версий: сравни значение `version` в `manifest.json` архива и в
  `seo-center-archives/latest.tar.gz` другой машины.
- **Совместимость Windows ↔ Linux:** архив `.tar.gz` универсален — открывается на Linux (`tar`) и на Windows (встроенный `tar.exe` в Windows 10 1803+, Проводник в Windows 11). Внутри архива пути относительные (`project/`, `home/...`), привязки к ОС/пользователю нет.
- В архив кладутся **оба установщика**: `install.sh` (Linux/macOS) и `restore.ps1` (Windows).

## Безопасность

Архив содержит **ключи доступа** (opencode auth, OmniRoute, `.env`) и по умолчанию
**зашифрован** (AES-256). Парольная фраза хранится отдельно
(`~/.config/opencode/seo-backup-pass`, права 600) и в архив не входит — при переносе
её передавай отдельным защищённым каналом.

Дополнительно:

- `--no-secrets` собирает архив без ключей/сессий/бренд-контекста — его можно
  передавать сторонним лицам.
- Права: папка `seo-center-archives/` — `700`, архивы — `600`.
- Не выкладывать архивы в публичные репозитории и мессенджеры.
- Для расшифровки на другом ПК: `--pass ПАРОЛЬ` либо файл `seo-backup-pass`.
  Пример несекретного открытого архива: `--no-secrets --no-encrypt`.
