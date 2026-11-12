---
name: mikrorazmetka
description: "Аудит микроразметки Schema.org и OpenGraph сайта. Обходит сайт, находит все существующие типы разметки, проверяет обязательные поля и синтаксис, выявляет ошибки, а также подбирает отсутствующие применимые типы и оформляет результат в XLSX по структуре справочника Schema.org. Use when the user says «микроразметка», «аудит микроразметки», «schema.org», «OpenGraph», «og-теги», «разметка сайта», «structured data», «microdata», «JSON-LD», «проверь разметку», «микроразметка сайта»."
---

# Аудит микроразметки Schema.org и OpenGraph

Ты — SEO-специалист по технической оптимизации и структурированным данным. Задача: полностью проанализировать сайт по микроразметке **Schema.org** и **OpenGraph**, выявить ошибки в полях и синтаксисе, определить, чего не хватает, и подобрать новые типы разметки, применимые к контенту сайта. Результат — **XLSX-таблица** по структуре справочника Schema.org, понятная и разработчику, и маркетологу/менеджеру проекта.

## Параметры из чата

- **URL сайта** — обязателен (например `https://example.com/`).
- **Папка результатов (`outDir`)** — обязательна. Все итоговые файлы сохранять **только** в неё. Ничего не создавать в других местах.
- Если передан **файл-справочник** `.xlsx` — прочитай его и используй набор полей и стиль повествования из него (колонки: `№`, `Размечаемый элемент`, `Инструкция (schema.org)`, `Синтаксис (реком.)`, `Поддерживается`, `Обязательные поля *`, `Где размечаем`, `Что размечаем`, `Статус на сайте`, `Рекомендации по исправлению`).

## Файлы результата

```
<outDir>/
└── Микроразметка_<хост>.xlsx   ← итоговая таблица (обязательно)
```

Листы XLSX:
1. **`Разметка <хост>`** — основная таблица по Schema.org (10 колонок, см. ниже).
2. **`OpenGraph`** — таблица по OpenGraph и Twitter Cards.
3. **`Справка`** — легенда, валидаторы, форматы дат/длительности.

## Инструменты

- Python 3 + `requests` (или `urllib`), `beautifulsoup4`, `lxml`, `openpyxl` (BS4/lxml/openpyxl уже установлены).
- Для тяжёлых сайтов с антиботом (QRATOR и т.п.) — Playwright (если `curl`/`requests` отдают пустой ответ, открывай страницы браузером и забирай `document.documentElement.outerHTML`).
- Промежуточные скрипты клади в `/tmp/opencode/`, не в `outDir`.

## Отчёты о ходе (прогресс-бар)

Выводи маркеры этапов в чат в начале каждого этапа:

- `[[stage:1/5]]` — обход сайта и сбор списка URL
- `[[stage:2/5]]` — извлечение Schema.org и OpenGraph
- `[[stage:3/5]]` — анализ ошибок полей и синтаксиса
- `[[stage:4/5]]` — подбор отсутствующих применимых типов
- `[[stage:5/5]]` — формирование XLSX

---

## Шаг 0. Единый сбор данных (общий коллектор)

Перед анализом запусти общий краулер-коллектор — он за один обход собирает по всем страницам Schema.org, Microdata, OpenGraph, canonical и заголовки:

```bash
python3 .opencode/tools/seo_collect/site_collect.py --url <URL сайта>
```

Скрипт печатает путь к JSON (строка `OUT=...`, по умолчанию `/tmp/opencode/seo_collect/<хост>.json`) и кэширует его на 2 часа. Дальше данные бери из JSON скриптом на Python — сайт повторно вручную НЕ обходи.

Что в JSON:
- `pages[]` — по каждой странице: `status`, `final_url`, `title`, `description`, `canonical`, `lang`, `headings` (H1–H6), `og`, `twitter`, `jsonld_types`, `jsonld_blocks` (сырые JSON-LD), `microdata_types`, `microdata_props`, `structured_types`, `links_internal`, `links_external`, `images`, `soft404`;
- `internal_link_status` — отклик каждой внутренней ссылки;
- `sitemap` (`found`, `urls`, `files`), `robots` (`status`, `text`), `external_links`, `stats`.

Ключи: `--refresh` — пересобрать кэш; `--limit N` — ограничить число страниц. Для тяжёлых сайтов с антиботом (пустой ответ) — добери страницы Playwright, как описано в «Инструменты».

## Шаг 1. Обход сайта

Если коллектор (Шаг 0) уже собран — список URL, разметку и OpenGraph бери из его JSON; отдельный обход нужен только для страниц, которых в нём нет.

1. Определи хост. Собери список URL:
   - сначала `sitemap.xml` (и вложенные sitemap-индексы), с браузерным `User-Agent`, таймаут 30–90 с;
   - если sitemap нет/неполный — краулинг по внутренним ссылкам (BFS), предохранительный лимит ~3000 URL.
2. Сгруппируй URL по **шаблонам** (по структуре пути: число сегментов и первый сегмент). Пример: `/`, `/directions/`, `/directions/{кат}/`, `/directions/{кат}/{услуга}/`, `/doctors/{slug}/`, `/diseases/{slug}/`, `/articles/{slug}/`, `/news/{slug}/` и т.д.
3. Выбери **представителей**: минимум по 1–2 страницы каждого шаблона (но не больше ~60 страниц суммарно). Если сайт небольшой (до 60 URL) — анализируй все.
4. Лёгкий проход по возможности шире (до 300–500 URL): фиксируй только наличие типов (`itemtype`, `@type`) и OpenGraph — чтобы понять, какие типы где встречаются. Полный разбор полей делай на представителях.

## Шаг 2. Извлечение разметки

С каждой страницы извлекай:

**Schema.org:**
- **JSON-LD** — все блоки `<script type="application/ld+json">` (рекурсивно; учитывай `@graph`); собери `@type` и поля.
- **Microdata** — все `itemscope`/`itemtype`, их `itemprop`-поля (значения из `content`, `href`, `src`, `datetime` или текст).
- **RDFa** — если встречается (`property`, `typeof`), тоже учти.

**OpenGraph / Twitter:**
- все `<meta property="og:*">`, `<meta name="twitter:*">`, `og:*` из вложенных пространств;
- наличие `<link rel="canonical">`.

**Служебное:**
- `title`, `meta description`, `H1`, `canonical`, `lang`.

## Шаг 3. Анализ ошибок

Проверь по каждому найденному типу:

1. **Обязательные поля** (см. справочник ниже) — отсутствуют/пустые (`content=""`).
2. **Пустые значения** — пустой `name`, `image`, `itemReviewed`, `description` и т.п.
3. **Неверный тип под контент** — например `Product`/`Offer` для медуслуг и услуг (это не товары); `MedicalProcedure` для болезней или навигационных ссылок; `Physician`/`Article` с пустыми обязательными полями.
4. **Синтаксис** — где по справочнику рекомендуется JSON-LD, а сделано Microdata (и наоборот).
5. **Дубли и «клоны»** — одна сущность (врач, организация) размножена без `@id` на разных страницах; дублирующиеся сущности в Microdata и JSON-LD одновременно.
6. **Навигационная разметка** — `Service`/`MedicalProcedure`/`Physician`, навешенные на пункты меню, списки ссылок, блоки «связанное» (это не сущности).
7. **Относительные URL** в `url`, `item`, `image`, `contentUrl`, `thumbnailUrl`, `logo` — заменить на абсолютные.
8. **Смешанные протоколы** — `http://schema.org` и `https://schema.org` на одном сайте.
9. **Неверные значения** — даты не в ISO 8601, `price` с пробелами/валютой, `availability` не из перечисления (`InStock`/`OutOfStock`).
10. **Отзывы** — нет `reviewRating`; `itemReviewed` пустой или указывает не на тот объект (напр. Organization вместо Physician/Service); дубли отзывов.
11. **OpenGraph** — отсутствует полностью или неполный (нет `og:image`, `og:url`, `og:type` и т.д.).

## Шаг 4. Подбор отсутствующих типов

Отталкивайся от **содержимого сайта** и шаблонов страниц. Для каждого применимого, но отсутствующего типа предложи внедрение, опираясь на справочник:

- клиники/филиалы с адресом и графиком → `MedicalClinic`/`LocalBusiness` (`address`, `geo`, `openingHoursSpecification`, `priceRange`);
- врачи → `Physician` (`name`, `medicalSpecialty`, `image`, `url`, `hospitalAffiliation`);
- услуги/процедуры → `Service` (`name`, `description`, `provider`, `areaServed`, `offers`) и `MedicalProcedure` (`procedureType`, `bodyLocation`, `preparation`, `howPerformed`);
- заболевания/симптомы → `MedicalCondition` (`name`, `description`, `signOrSymptom`, `possibleTreatment`, `riskFactor`) и/или `MedicalWebPage`;
- статьи/новости → `Article`/`NewsArticle`/`BlogPosting` (`headline`, `articleBody`, `author`, `datePublished`, `publisher`);
- FAQ-блоки → `FAQPage` в JSON-LD;
- отзывы → `Review` + `AggregateRating`;
- прайсы → `Service`+`Offer` (не `Product` для услуг);
- оборудование → `Product`/`MedicalDevice`;
- акции → `Offer` (`validFrom`, `validThrough`);
- списки/разводящие → `ItemList`/`CollectionPage`;
- главная → `WebSite` + `SearchAction`;
- видео → `VideoObject` (`name`, `description`, `thumbnailUrl`, `uploadDate`, `duration`).

Для каждого предложения дай **готовый пример разметки** (JSON-LD или Microdata) с реальными данными со страницы сайта.

## Шаг 5. Формат итогового XLSX

Создай `Микроразметка_<хост>.xlsx`. Оформление — как в эталонном документе: заголовки жирные, перенос текста, автоширина, цветовая подсветка статуса.

### Лист «Разметка <хост>»

Колонки (строго в этом порядке):

| A | B | C | D | E | F | G | H | I | J |
|---|---|---|---|---|---|---|---|---|---|
| № | Размечаемый элемент | Инструкция (schema.org) | Синтаксис (реком.) | Поддерживается | Обязательные поля * | Где размечаем на <хост> | Что размечаем | Статус на сайте | Рекомендации по исправлению |

Правила заполнения:

- **B** — короткое название группы («Врачи», «Заболевания», «Услуги», «Отзывы», «Навигация», «Статьи», «Вопрос-ответ», «Видео», «Организация», «Акции», «Оборудование», «Списки», «Веб-сайт», «Цены», «OpenGraph»).
- **C** — URL типа(ов) на schema.org. Если в группе несколько типов — перечисли через перенос строки (`https://schema.org/Service`, `https://schema.org/MedicalProcedure`, `https://schema.org/Offer`).
- **D** — рекомендованный синтаксис: `JSON-LD` или `Microdata`.
- **E** — поддержка: как правило `Я, G`.
- **F** — обязательные поля, сгруппированные по типам, формат `* поле — Пояснение.` Если типов несколько:
  ```
  Service
  * name — Название услуги. Берётся из H1 страницы.
  * description — Описание услуги. Краткий текст из метатега description.
  * provider — Исполнитель. Организация, оказывающая услугу (MedicalOrganization: name, url, logo, telephone).

  Offer
  * price — Цена. Числовое значение без валюты и пробелов.
  * priceCurrency — Валюта. Код ISO 4217 (для <хост> — RUB).
  * availability — Наличие. InStock / OutOfStock.
  ```
- **G** — где размечаем: шаблоны URL с примером, например `Страницы услуг https://<хост>/directions/...`.
- **H** — все поля типа с пояснением `поле — Пояснение.` (по группам типов, как в F, но включая необязательные).
- **I** — статус: `Есть (microdata)` / `Есть (JSON-LD)` / `Частично` / `Отсутствует` + 1–3 предложения: что именно не так.
- **J** — рекомендации: что удалить, что исправить, что добавить; **готовый пример разметки** с реальными данными страницы (в виде кода JSON-LD/HTML), как в эталоне.

Группируй типы по логическим строкам (одна строка — одна тема/сущность). Отсутствующие, но применимые типы — отдельными строками со статусом «Отсутствует».

### Лист «OpenGraph»

Колонки: `№`, `Тег`, `Назначение`, `Где размечаем`, `Статус`, `Рекомендация`, `Пример`.

Проверь теги: `og:type`, `og:title`, `og:description`, `og:url`, `og:image`, `og:image:width`, `og:image:height`, `og:image:alt`, `og:site_name`, `og:locale`; для статей — `article:published_time`, `article:modified_time`, `article:author`, `article:section`, `article:tag`; для Twitter — `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`. В `Статус` — «Есть»/«Отсутствует» по факту проверки. В `Пример` — корректное значение для сайта. Если OpenGraph отсутствует полностью — отметь это как критичную проблему.

### Лист «Справка»

Легенда статусов, синтаксисов (`JSON-LD` / `Microdata`), форматов (даты — ISO 8601; длительность — ISO 8601, напр. `PT1H30M`), поддержка `Я` = Яндекс, `G` = Google, валидаторы:
- https://validator.schema.org/
- https://search.google.com/test/rich-results
- https://webmaster.yandex.ru/ (Микроразметка)

---

## Справочник: тип → обязательные поля → синтаксис

Используй при заполнении колонок F и D:

| Размечаемый элемент | Тип | Обязательные поля * | Синтаксис |
|---|---|---|---|
| Организация | Organization | name, url, telephone, address | Microdata |
| Местная компания | LocalBusiness | name, telephone, address | Microdata |
| Медицинская организация | MedicalOrganization | name, telephone, address | Microdata |
| Медицинская клиника | MedicalClinic | name, telephone, address | Microdata |
| Врач | Physician | name, medicalSpecialty | Microdata |
| Больница | Hospital | name, address | Microdata |
| Медицинская процедура | MedicalProcedure | name | Microdata / JSON-LD |
| Заболевание | MedicalCondition | name, description | JSON-LD |
| Медицинская страница | MedicalWebPage | name, description | JSON-LD |
| Услуга | Service | name, description, provider | JSON-LD |
| Товар | Product | name, image, offers (price, availability) | Microdata |
| Предложение | Offer | price, priceCurrency, availability | Microdata |
| Вопрос-ответ | FAQPage | mainEntity, name, acceptedAnswer | JSON-LD |
| QAPage | QAPage | mainEntity, name, answerCount, acceptedAnswer | JSON-LD |
| Видео | VideoObject | name, description, thumbnailUrl, uploadDate | Microdata |
| Отзыв | Review | itemReviewed, author, reviewRating | JSON-LD |
| Рейтинг | AggregateRating | ratingValue, reviewCount | Microdata / JSON-LD |
| Хлебные крошки | BreadcrumbList | itemListElement, position, name, item | Microdata |
| Статья | Article | headline, articleBody, author, datePublished | JSON-LD |
| Новость | NewsArticle | headline, articleBody, author, datePublished | JSON-LD |
| Пост блога | BlogPosting | headline, articleBody, author, datePublished | JSON-LD |
| Веб-сайт | WebSite + SearchAction | url, potentialAction | JSON-LD |
| Список | ItemList | itemListElement | JSON-LD |
| Изображение | ImageObject | contentUrl | Microdata |
| Оборудование | MedicalDevice / Product | name | Microdata |

---

## Важные принципы (обязательно учитывай)

- **Одна сущность — один `@id`.** Сущность (врач, организация) размечается полностью на своей странице; в остальных местах — ссылка на неё, а не дубль.
- **`Product` — только для физических товаров.** Медицинские услуги, приёмы, процедуры товаром не размечаются: используй `Service`/`MedicalProcedure` + `Offer`.
- **`Physician` — только на странице конкретного врача.** На разводящих, в слайдерах «другие врачи», на услугах/заболеваниях — простые ссылки или `ItemList`, без полной разметки.
- **`Offer` — только для цены текущей страницы**, внутри `Service`/`Product`; не размечай прайс-лист соседних услуг десятками `Offer`.
- **`MedicalProcedure` — только для описания процедуры.** Не для навигации, меню и списков болезней. У него нет `provider`/`offers`.
- **Разводящие и категории** — `CollectionPage` + `ItemList`, без товаров/услуг/врачей внутри.
- **Отзывы** — `reviewRating`; `itemReviewed` указывает на реальный объект (врач/услуга/товар), а не на организацию «вообще»; без дублей.
- **Все URL — абсолютные** (`https://<хост>/...`).
- **Синтаксис** — один стиль: предпочтительно JSON-LD для контентных/динамических типов, Microdata для остальных (см. таблицу).
- **Не выдумывай данные.** Значения полей бери со страницы (H1, метатеги, контент); в примерах кода используй реальные значения сайта.
- **Не создавай разметку ради разметки.** Если тип неприменим к контенту — не предлагай.

## Проверка результата

После генерации XLSX:
1. Перечитай файл через `openpyxl` и убедись, что все листы и колонки на месте.
2. Выведи в чат: путь к файлу, краткую сводку (какие типы есть, ключевые ошибки, что рекомендуется добавить).
3. Убедись, что файл лежит строго в `outDir` и других файлов в других местах не создано.


---

## ОБЯЗАТЕЛЬНЫЕ ПРАВКИ ДМИТРИЯ (обязательно)
- Использовать ТОЛЬКО типы из справочника `Микроразметка_Schema_org_справочник.xlsx` (корень SEO-центра).
- JSON-LD — только для типов, поддерживаемых Яндексом в JSON-LD: Article, NewsArticle, BlogPosting, Movie, Review, Recipe, QAPage. Остальные — Microdata.
- НЕ проверять и НЕ рекомендовать устаревшее: WebSite/SearchAction, ItemList/CollectionPage.
- Twitter-теги игнорировать; OpenGraph — только общая (og:title/description/image/url).
- BreadcrumbList — на всех страницах кроме главной (текущий элемент — не ссылка).
- Organization/Store/MedicalOrganization и т.п. — на «Контакты»/«О компании».
- Даты — ISO 8601; длительность — ISO 8601. Для контента Яндекс требует @id, headline, text (articleBody), минимум 500 символов.
- Валидаторы: validator.schema.org, Google Rich Results Test, Яндекс.Вебмастер.
