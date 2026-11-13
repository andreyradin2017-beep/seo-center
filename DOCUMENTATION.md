# Документация проекта «SEO-центр»

Веб-панель — визуальный запуск навыков opencode + набор SEO-инструментов
(метатеги, аудит, статьи, SMM) и блок аналитики аудитов.

- Плагин: `.opencode/plugin/seo-ui.ts`
- Панель (HTTP UI): по умолчанию `http://localhost:4180`
- Боевой контур на сервере: см. `AGENTS.md` (системные юниты, deploy.sh)

---

## 1. Запуск

Открой папку проекта в opencode — плагин поднимает UI автоматически.
Альтернативно — отдельным процессом (развязанный режим, клиент SDK).

Переменные окружения:

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `SEO_UI_PORT` | Порт панели | `4180` |
| `SEO_UI_BIND` | Интерфейс прослушивания (`127.0.0.1` — только локально) | `0.0.0.0` |
| `SEO_RESULTS_DIR` | Корень результатов | `<projectDir>/seo-results` |
| `SEO_QUEUE_STATE_FILE` | Файл очереди аудитов | `SEO_RESULTS_DIR/.queue.json` |
| `SEO_UPLOADS_DIR` | Папка загрузок (сем. ядро и т.п.) | `<projectDir>/.opencode/uploads` |
| `SEO_CENTER_ENV` | `test` — тестовый инстанс (бейдж «ТЕСТ») | — |
| `SEO_UI_AUTH=0` | Отключить авторизацию | включена |
| `SEO_UI_ADMIN_PASSWORD` | Пароль администратора | — |
| `SEO_UI_IT_PASSWORD` | Пароль IT-администратора | — |
| `SEO_UI_ALLOW_IPS` | Allowlist по IP (`192.168.0.*`, CIDR) | пусто — всем |
| `SEO_UI_UNIT_NAME` (через `SEO_UNIT_NAME`) | Юнит для кнопки рестарта в админке | — |
| `SEO_CENTER_MODEL`, `SEO_CENTER_MODEL_FREE`, `SEO_CENTER_MODEL_POLISH`, `SEO_CENTER_FREE_TOOLS` | Модели агента | см. код |
| `OPENCODE_SEO_UI_NO_OPEN=1` | Не открывать браузер автоматически | — |
| `OPENCODE_GEO_TRACKER`, `OPENCODE_GEO_TRACKER_PORT` | Geo/AEO tracker (если папка есть) | — |

Запуск панели вручную (из корня проекта):

```bash
SEO_UI_PORT=4180 node --experimental-strip-types .opencode/plugin/seo-ui.ts
```

## 2. Структура

```
.opencode/
├── plugin/seo-ui.ts        # плагин: HTTP-сервер, очередь, все маршруты
├── lib/
│   ├── security.ts         # auth, пароли (scrypt), allow-list, безопасные пути
│   ├── json-store.ts       # атомарная запись JSON
│   ├── audit-store.ts      # аналитика: скор, история, проблемы, расписание, Telegram
│   ├── generators.ts       # robots.txt, sitemap.xml, JSON-LD
│   ├── integrations.ts     # PSI, Search Console, Вебмастер, Метрика
│   └── pages.ts            # /insights и /generators (HTML + клиентский JS)
├── rules/audit-rules.md    # единые правила аудита + схема audit.json
├── tests/                  # тесты node:test (запуск: npm test)
├── skills/…                # навыки (метатеги, аудит, статьи, SMM)
└── tools/seo_collect/      # общий HTTP-кэш для Python-скриптов + тесты
```

Тесты: `npm test` → `node --test .opencode/tests/` (33 теста:
security, audit-store, generators, integrations, panel e2e).

## 3. Основные разделы панели

- **SEO-инструменты / SEO-аудит / SMM** — запуск навыков, форма аудита
  (выбор пунктов, глубины 2.1/4.1, сем. ядро, пресеты).
- **Результаты / Результаты аудита** — файлы прогонов (docx/xlsx), скачивание,
  удаление, ретеншен.
- **Аналитика** (`/insights`, только admin/it):
  - Сводка по сайтам: скор, гейт, дельта, открытые проблемы.
  - История прогонов (открыть отчёт с дельтой, «Повторить»).
  - Проблемы: статусы open / in_progress / fixed / ignored, заметки.
  - Расписание: авто-повтор аудита (каждые N дней, час).
  - Интеграции: PSI, Search Console, Вебмастер, Метрика (вставка токена +
    проверка кнопкой).
  - Telegram-уведомления о завершении аудита.
- **Генераторы** (`/generators`, только admin/it): robots.txt (с обязательным
  `Disallow: /*?`), sitemap.xml, CSV → URL-список, JSON-LD с валидацией.
- **Админ-панель** (`/admin`, только admin/it): пользователи, лимит
  одновременных аудитов, очередь, задачи, проекты, логи и бэкапы (it).

## 4. Аудит: контракт `audit.json`

После каждого прогона агент сохраняет рядом с «SEO-аудит.docx» файл `audit.json`
по схеме из `.opencode/rules/audit-rules.md`. По нему панель считает скор
(0–100), гейт, историю, дельту и проблемы.

```json
{
  "host": "example.com",
  "site": "https://example.com/",
  "generatedAt": "2026-11-12T10:30:00+03:00",
  "summary": "Короткий итог прогона",
  "points": [
    {
      "point": "2.3", "title": "Служебные теги", "checkedPages": 40,
      "summary": "…", "positive": ["…"],
      "issues": [{ "title": "Пустые title", "severity": "high", "urls": ["https://…"], "fix": "…", "count": 12 }]
    }
  ]
}
```

- `severity`: только `high` / `medium` / `low`.
- Пункт без проблем: `"issues": []`.
- Состояние в корне результатов: `.runs.json`, `.issues.json`, `.settings.json`-подобный
  файл настроек (`.insights.json`), а также `.queue.json`.

## 5. Поток аудита

1. Форма / «Повторить» / планировщик → общий `enqueueAudit` →
   `buildAuditPrompts` (скриптовые + модельные + сборка).
2. Скриптовые пункты (2.1–2.5, 3.1, 3.2, 4.1, 4.2) — по SKILL.md, с маркерами
   `.point_<n>_done` и `.scripts_done`; скриптам передаётся `--cache <outDir>/.cache`.
3. Модельные пункты + сборка единого «SEO-аудит.docx» + `audit.json` → правила
   из `.opencode/rules/audit-rules.md`.
4. `recordAuditRun`: скор/гейт/дельтa, проблемы, история, Telegram.

Очередь персистится (`.queue.json`) и восстанавливается после рестарта; лимит
одновременных аудитов настраивается в админке.

## 6. Ключевые API (под `/api/...`)

- Служебные: `GET /api/health`, `GET /api/projects`, `GET /api/tasks`,
  `POST /api/tasks/cancel`, `POST /api/delete`, `POST /api/delete-all`,
  `GET /api/download`, очередь `GET /api/audit-queue`, `POST /run-audit`,
  `POST /run-audit-cancel`, `POST /run-extract`, `POST /api/revise`.
- Аналитика (admin/it): `GET /api/insights/overview`, `/api/insights/history`,
  `/api/insights/report?run=`, `/api/insights/issues`, `POST /api/insights/issues/status`,
  `/api/insights/settings`, `POST /api/insights/telegram`, `POST /api/insights/integrations`,
  `POST /api/insights/integrations/test`, `POST /api/insights/schedules` (+ `toggle`/`delete`),
  `POST /api/insights/repeat`.
- Генераторы (admin/it): `GET/POST /api/presets`, `POST /api/generate`
  (`kind`: robots | sitemap | sitemap-from-csv | jsonld-template | jsonld).
- Админ: все под `/api/admin/*` (admin/it; логи/бэкапы — только it).

## 7. HTTP-кэш скриптов

`.opencode/tools/seo_collect/http_cache.py` — кеширует GET-ответы сайта
(ключ sha256, gzip+JSON, атомарная запись, TTL 7200 с). Используется 6
скриптами аудита с флагом `--cache <dir>`. Тест: `test_http_cache.py`
(unittest, Python 3, зависимости: requests).

## 8. Аналогичные инструменты и предложения по развитию

### Что у нас уже есть (по скилам)
- Адреса страниц, дубликаты, заголовки откликов сервера, индексация, топология ссылок (п.1).
- Текстовый контент, оформление текста, служебные теги, изображения, исходящие ссылки, микроразметка (п.2).
- Сниппеты, внешние ссылки, скорость загрузки, перебои в работе (п.3–4).
- Семантическое ядро (wordstat), темы статей, статьи, SMM-группы.
- Бэкап/восстановление (`seo-center-backup`), админ-панель с пользователями и очередью.

### На что ориентироваться на рынке
Популярные коммерческие и открытые инструменты технического аудита: Screaming Frog SEO Spider, Sitebulb, Ahrefs Site Audit, SEMrush Site Audit, Google Search Console, PageSpeed Insights, Lighthouse. Из open-source — краулеры на Scrapy/Playwright,さまさま JS-сканеры метатегов.

### Предложения по улучшению (бэклог, не реализовано пока)
1. **Массовая проверка HTTP-откликов** — сейчас есть только навык «Заголовки откликов сервера» (по требованию). Можно добавить сканирование всех найденных URL и отчёт не-200 в аналитике.
2. **Core Web Vitals массово** — интеграция PSI есть, но проверяется вручную по одной URL; можно проверить ключевые страницы по расписанию.
3. **Визуальное сравнение двух аудитов** — сейчас дельта только по скору и проблемам; полезно сравнивать метатеги страниц между прогонами.
4. **Экспорт проблем в CSV** — для передачи списка исправлений разработчикам.
5. **OpenGraph/социальные разметки** — сейчас микроразметка по Schema.org; можно добавить проверку OG-тегов.

Реализация по запросу.
