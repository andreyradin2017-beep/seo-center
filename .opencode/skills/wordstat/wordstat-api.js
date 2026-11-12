#!/usr/bin/env node
/*
 * wordstat-api.js — сбор данных Wordstat через внутренний JSON API Яндекса
 * (POST https://wordstat.yandex.ru/wordstat/api/getGraph) без постоянного окна
 * с вводом номера телефона.
 *
 * Как это работает:
 *  1) ОДИН раз выполняется авторизация в оконном браузере (ввод номера + SMS-код).
 *     В этот момент перехватывается реальный запрос /wordstat/api/getGraph
 *     (URL, заголовки, cookies, тело) и сохраняется в api-session.json.
 *  2) Все последующие запуски работают ЧИСТО через HTTP API (Node fetch),
 *     окно браузера не открывается, номер телефона вводить не нужно.
 *
 * Использование:
 *  node wordstat-api.js <список.tsv> [опции]
 *
 * Опции:
 *  --out <файл.tsv>      куда писать сводку частотностей (по умолчанию frequencies.tsv)
 *  --csvDir <папка>      куда писать СВОДНЫЙ документ со всеми запросами (по умолчанию csv/)
 *  --summary             не писать сводный документ, только frequencies.tsv
 *                        (режим навыка тем: нужны лишь частотности запросов)
 *  --graphType month|week|day   разбивка графика (по умолчанию month)
 *  --start DD.MM.YYYY    начальный период (по умолчанию из сессии, напр. 01.09.2024)
 *  --end   DD.MM.YYYY    конечный период   (по умолчанию из сессии, напр. 31.08.2026)
 *  --region N            регион (по умолчанию из сессии; 225 = Россия)
 *  --renew               заново авторизоваться и переснять сессию
 *  --headless            окно входа не показывать (для Xvfb), только с --renew
 *  --queries "a\nb\nc"   список запросов прямо в команде (вместо файла)
 *
 * Фоновый режим (без окон на экране):
 *  - Если api-session.json есть и живая — окно НЕ открывается, сбор идёт по HTTP.
 *  - Окно появляется только при --renew (нужен ручной вход по SMS).
 *  - Чтобы и окно входа не мешало: обернуть в виртуальный дисплей Xvfb:
 *        xvfb-run -a node wordstat-api.js <список.tsv> --renew --headless
 *        WORDSTAT_HEADLESS=1 node wordstat-api.js <список.tsv> --renew
 *    (в Xvfb окно рисуется виртуально; для ввода SMS используйте видимый режим
 *     либо подготовьте сессию один раз обычным --renew)
 */
const fs = require('fs');
const path = require('path');

const SKILL_DIR = __dirname;
const SESSION_FILE = path.join(SKILL_DIR, 'api-session.json');
const PROFILE_DIR = path.join(SKILL_DIR, 'pw-profile');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}
function flag(name) { return process.argv.includes('--' + name); }

const TSV = arg('queries', null)
  ? null
  : (process.argv[2] || '');
const OUT = arg('out', path.join(SKILL_DIR, 'frequencies.tsv'));
const CSV_DIR = arg('csvDir', path.join(SKILL_DIR, 'csv'));
// Режим «только частотности»: не собирать сводный документ с историческими
// сериями (используется навыком тем — ему нужны лишь частотности запросов).
const SUMMARY_ONLY = flag('summary') || flag('noSeries') || flag('no-csv');

// ---------- парсинг запросов ----------
function loadQueries() {
  if (arg('queries', null)) {
    return String(arg('queries', null)).split('\n').map((s, i) => ({ i, kw: s.trim() })).filter(q => q.kw);
  }
  const raw = fs.readFileSync(TSV, 'utf-8');
  return raw.split('\n').filter(Boolean).map((line, i) => {
    const parts = line.split('\t');
    // Формат: индекс \t тема \t запрос. Если индекс задан — используем его
    // (важно для дозапроса/дополнений, чтобы не конфликтовать с уже собранными),
    // иначе берём позицию строки.
    if (parts.length >= 3) {
      const ti = String(parts[0]).trim();
      const t = parts[1];
      const kw = parts.slice(2).join('\t');
      return { i: ti !== '' ? ti : String(i), t, kw: String(kw).trim() };
    }
    return { i: String(i), t: '', kw: String(line).trim() };
  });
}

// ---------- HTTP-клиент (без браузера) ----------
// Используем https-модуль напрямую, а не глобальный fetch (undici),
// т.к. undici в этой среде зависает на wordstat.yandex.ru.
const https = require('https');
const { URL } = require('url');

function httpJson(url, { method, headers, body, timeout = 30000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: method || 'POST',
      headers: Object.assign({ 'Accept': 'application/json' }, headers, payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      timeout,
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------- сохранение сессии ----------
function saveSession(sess) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(sess, null, 2));
  console.log('Сессия сохранена: ' + SESSION_FILE);
}

// Дедупликация cookies по имени. Playwright возвращает куки со всех домейнов
// (включая passport.yandex.ru, .yandex.ru, wordstat.yandex.ru) с одинаковыми
// именами, но разными значениями; при склейке в один заголовок Cookie Яндекс
// получает мусор и отдаёт 302 на паспорт. Предпочитаем куки с домена
// wordstat.yandex.ru, затем .yandex.ru, затем остальные; позже увиденное
// значение того же имени затирает раннее (порядок как в браузере).
function buildCookieHeader(cookies) {
  const score = (domain) => {
    const d = String(domain || '').toLowerCase();
    if (d === 'wordstat.yandex.ru') return 3;
    if (d === '.yandex.ru' || d === 'yandex.ru') return 2;
    if (d.endsWith('yandex.ru')) return 1;
    return 0;
  };
  const byName = new Map();
  for (const c of cookies) {
    if (!c || !c.name) continue;
    const prev = byName.get(c.name);
    if (!prev || score(c.domain) >= score(prev.domain)) {
      byName.set(c.name, { value: c.value, domain: c.domain });
    }
  }
  return [...byName.entries()].map(([name, v]) => name + '=' + v.value).join('; ');
}

function loadSession() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch (e) { return null; }
}

// ---------- этап 1: авторизация в окне + перехват запроса ----------
// По умолчанию окно входа показывается только при --renew (это единственный
// шаг, где нужен реальный экран для ввода SMS-кода). Если задан --headless
// (или переменная WORDSTAT_HEADLESS=1), браузер запускается без окна — удобно
// под Xvfb: `xvfb-run -a node wordstat-api.js ... --renew --headless`.
function renewHeadless() {
  return flag('headless') || process.env.WORDSTAT_HEADLESS === '1';
}

async function renewSession() {
  const { chromium } = require('playwright');
  fs.mkdirSync(SKILL_DIR, { recursive: true });
  const headless = renewHeadless();
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    viewport: { width: 1500, height: 1000 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  let captured = null;
  const capturedReady = new Promise((resolve) => {
    page.on('request', req => {
      const url = req.url();
      if (url.includes('/wordstat/api/getGraph') && req.method() === 'POST') {
        if (!captured) {
          captured = {
            url,
            postData: req.postData() ? JSON.parse(req.postData()) : null,
            headers: req.headers(),
          };
        }
      }
    });
    page.on('response', async res => {
      if (res.url().includes('/wordstat/api/getGraph') && res.status() === 200) {
        resolve();
      }
    });
  });

  console.log('Откройте wordstat в открывшемся окне, при необходимости войдите по номеру телефона.');
  console.log('Затем введите любой запрос в поле поиска и откройте вкладку «Динамика» (graph).');
  console.log('Как только данные графика загрузятся, сессия будет перехвачена автоматически.\n');

  await page.goto('https://wordstat.yandex.ru/?region=225&view=graph&words=' + encodeURIComponent('тест'),
    { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  const timeout = new Promise(r => setTimeout(r, 5 * 60 * 1000));
  await Promise.race([capturedReady, timeout]);

  // собрать cookies (дедупликация по имени: одноимённые куки с разных домейнов
  // ломают авторизацию при ручной подстановке заголовка Cookie — оставляем
  // значение с наиболее подходящего домена, i.e. последнее для .yandex.ru)
  const cookies = await ctx.cookies();
  const cookieHeader = buildCookieHeader(cookies);

  if (!captured) {
    console.error('Не удалось перехватить запрос getGraph за 5 минут. Проверьте, что вы выполнили поиск и открыли «Динамику».');
    await ctx.close();
    process.exit(2);
  }

  // заголовки для повторного использования (cookies подставляем отдельно)
  const headers = {};
  for (const k of Object.keys(captured.headers)) {
    const lk = k.toLowerCase();
    if (lk === 'cookie' || lk === 'content-length' || lk === 'host') continue;
    headers[k] = captured.headers[k];
  }

  const sess = {
    capturedAt: new Date().toISOString(),
    url: captured.url,
    body: captured.postData,
    headers,
    cookies: cookieHeader,
  };
  saveSession(sess);
  await ctx.close();
  console.log('\nСессия перехвачена. Дальше можно собирать без окна:');
  console.log('  node wordstat-api.js ' + (TSV || '<список.tsv>') + '\n');
  return sess;
}

// ---------- этап 2: сбор через HTTP API ----------
async function collect(sess, queries) {
  // параметры из командной строки или из перехваченной сессии
  const graphType = arg('graphType', sess.body.currentGraphType || 'month');
  const start = arg('start', sess.body.startDate || '');
  const end = arg('end', sess.body.endDate || '');
  const region = arg('region', null);
  // Параллельность: по умолчанию 1 (как раньше, безопасно).
  // Значение >1 ускоряет сбор, но повышает риск капчи/лимитов — использовать умеренно (4–6).
  let concurrency = parseInt(arg('concurrency', '1'), 10);
  if (isNaN(concurrency) || concurrency < 1) concurrency = 1;
  if (concurrency > 8) concurrency = 8;
  // Глобальный лимит: не более N запросов в секунду суммарно (по умолчанию ~0.8/с, как пауза 1.2 с).
  const ratePerSec = (() => {
    const v = parseFloat(arg('rate', ''));
    if (!isNaN(v) && v > 0) return v;
    return 1 / 1.2;
  })();

  const body = JSON.parse(JSON.stringify(sess.body));
  body.currentGraphType = graphType;
  if (start) body.startDate = start;
  if (end) body.endDate = end;

  // регион: кладём в фильтры (по образцу сессии), если задан
  if (region) {
    if (Array.isArray(body.filters)) {
      body.filters = body.filters.filter(f => !(f && (f.key === 'region' || f.filterType === 'region')));
      body.filters.push({ key: 'region', value: region });
    } else if (body.filters && typeof body.filters === 'object') {
      body.filters.region = region;
    }
  }

  const rows = [];
  let done = new Set();
  if (fs.existsSync(OUT)) {
    rows.push(...fs.readFileSync(OUT, 'utf-8').split('\n').filter(Boolean));
    done = new Set(rows.map(l => l.split('\t')[0]));
  }

  if (!SUMMARY_ONLY) fs.mkdirSync(CSV_DIR, { recursive: true });
  // Собираем серии всех запросов, чтобы в конце записать ОДИН сводный документ.
  const allSeries = [];

  const pending = queries
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => !done.has(String(q.i)));

  // Глобальный распределитель темпа: следующий слот = max(now, prev + 1/rate)
  let nextSlot = 0;
  async function throttle() {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + 1000 / ratePerSec;
    const wait = slot - now;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }

  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const { q, i } = pending[cursor++];
      const key = String(q.i);
      await throttle();
      const thisBody = JSON.parse(JSON.stringify(body));
      thisBody.searchValue = q.kw;

      process.stdout.write(`[${i + 1}/${queries.length}] ${q.kw} ... `);
      try {
        const r = await httpJson(sess.url, {
          method: 'POST',
          headers: Object.assign({ 'Cookie': sess.cookies, 'Content-Type': 'application/json' }, sess.headers),
          body: thisBody,
        });

        if (r.status !== 200) {
          // возможно сессия протухла
          if (r.status === 401 || (r.json && r.json.error && String(r.json.error).toLowerCase().includes('auth'))) {
            console.log('сессия протухла — нужен --renew');
            saveRow(key, q, 'auth_error');
          } else {
            console.log('HTTP ' + r.status);
            saveRow(key, q, 'http_' + r.status);
          }
          continue;
        }

        const series = extractGraphSeries(r.json, graphType);
        if (series) {
          allSeries.push({ q, series });
          // суммарная/итоговая частота — последняя доступная точка (как раньше)
          const last = series[series.length - 1];
          saveRow(key, q, String(last[1]));
          console.log('freq=' + last[1] + '  (точек: ' + series.length + ')');
        } else {
          saveRow(key, q, '');
          console.log('freq=— (нет данных)');
        }
      } catch (e) {
        saveRow(key, q, 'error');
        console.log('ERR ' + String(e));
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, pending.length || 1) }, () => worker());
  await Promise.all(workers);

  // ОДИН сводный документ на задание: строка — период, колонка — запрос.
  if (!SUMMARY_ONLY && allSeries.length) saveCombinedCsv(allSeries, graphType);

  function saveRow(key, q, freq) {
    rows.push([key, q.kw, q.t ? q.t.replace(/\t/g, ' ') : '', freq].join('\t'));
    fs.writeFileSync(OUT, rows.join('\n'));
  }

  function saveCombinedCsv(items, gType) {
    items.sort((a, b) => {
      const na = Number(a.q.i), nb = Number(b.q.i);
      if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
      return String(a.q.i).localeCompare(String(b.q.i));
    });
    // Общий список периодов в порядке появления (серии идут хронологически).
    const periods = [];
    const seen = new Set();
    for (const it of items) {
      for (const [p] of it.series) if (!seen.has(p)) { seen.add(p); periods.push(p); }
    }
    const lookups = items.map(it => {
      const m = new Map();
      for (const [p, n] of it.series) m.set(p, n);
      return m;
    });
    const cell = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const header = ['Период'].concat(items.map(it => String(it.q.kw)));
    const lines = [header.map(cell).join(',')];
    for (const p of periods) {
      lines.push([p].concat(lookups.map(m => (m.has(p) ? m.get(p) : ''))).map(cell).join(','));
    }
    const f = path.join(CSV_DIR, `wordstat_${gType}.csv`);
    fs.writeFileSync(f, '\uFEFF' + lines.join('\r\n'));
    console.log('Сводный документ: ' + f + '  (запросов: ' + items.length + ', периодов: ' + periods.length + ')');
  }
}

// ---------- извлечение серии из ответа getGraph ----------
// возвращает массив пар [период, число] или null
function extractGraphSeries(json, graphType) {
  if (!json) return null;
  const candidates = [];
  function walk(v) {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      if (v.length && v[0] && typeof v[0] === 'object' && ('startTimestamp' in v[0] || 'absoluteValue' in v[0] || 'value' in v[0])) {
        candidates.push(v);
        return;
      }
      for (const x of v) walk(x);
      return;
    }
    for (const k of Object.keys(v)) {
      const val = v[k];
      if (Array.isArray(val) && val.length && val[0] && typeof val[0] === 'object' &&
          ('startTimestamp' in val[0] || 'absoluteValue' in val[0] || 'value' in val[0])) {
        candidates.push(val);
      }
      walk(val);
    }
  }
  walk(json);

  if (!candidates.length) return null;

  // берём самый длинный массив точек (данные графика по периодам)
  const best = candidates.sort((a, b) => b.length - a.length)[0];
  const out = [];
  for (const p of best) {
    const raw = p.absoluteValue != null ? p.absoluteValue : p.value;
    if (raw == null) continue;
    const n = Number(String(raw).replace(/\s+/g, '').replace(',', '.'));
    if (isNaN(n)) continue;
    const ts = Number(p.startTimestamp);
    let label = p.text;
    if (ts) {
      const d = new Date(ts);
      if (graphType === 'month') {
        const MONTHS = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
        label = `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
      } else {
        label = d.toISOString().slice(0, 10);
      }
    }
    out.push([label, n]);
  }
  return out.length ? out : null;
}

// ---------- main ----------
(async () => {
  let sess = loadSession();
  if (!sess || flag('renew')) {
    sess = await renewSession();
  } else {
    console.log('Использую сохранённую сессию от ' + sess.capturedAt + ' (без окна).');
  }

  const queries = loadQueries();
  if (!queries.length) {
    console.error('Нет запросов. Передайте .tsv файл или --queries "a\nb\nc".');
    process.exit(1);
  }

  await collect(sess, queries);
  console.log('\nГОТОВО: ' + OUT);
})().catch(e => { console.error(e); process.exit(1); });
