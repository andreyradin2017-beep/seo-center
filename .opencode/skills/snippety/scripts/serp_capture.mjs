/**
 * Пункт 3.1 «Сниппеты» — захват выдачи по запросу «site:<домен>» в Яндексе и Google.
 *
 * Открывает реальный браузер (Playwright, persistent profile), ждёт загрузки результатов,
 * при капче ждёт (если запущено с --headful), сохраняет скриншоты и serp.json. По умолчанию — без окна.
 *
 * Запуск (из каталога проекта; playwright ищется автоматически в node_modules проекта,
 * рядом с навыком, в глобальном npm или по переменной PLAYWRIGHT_DIR):
 *   node scripts/serp_capture.mjs --url https://www.roysol.ru/ --out-dir /путь/результатов
 *
 * Параметры:
 *   --url        URL сайта (обязательно)
 *   --out-dir    папка результатов (по умолчанию текущая)
 *   --profile    каталог профиля браузера (по умолчанию ./pw-profile рядом со скриптом)
 *   --headful    показать окно браузера (по умолчанию — фоновый режим, без окна)
 *   --wait       сколько секунд ждать ручного прохождения капчи (по умолчанию 120)
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Playwright может лежать в node_modules проекта, а не рядом со скриптом.
// Ищем его в нескольких местах, чтобы не создавать симлинки вручную.
function loadPlaywright() {
  const tryFrom = (base) => {
    try {
      const req = createRequire(join(base, 'noop.js'));
      return req('playwright');
    } catch { return null; }
  };
  try { return createRequire(import.meta.url)('playwright'); } catch { /* ищем дальше */ }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..'),                     // <skill>/
    join(here, '..', '..'),               // <skills>/
    join(here, '..', '..', '..'),         // .opencode/
    join(here, '..', '..', '..', '..'),   // корень проекта
    join(here, '..', '..', '..', '..', '..'),
    process.cwd(),
    process.env.PLAYWRIGHT_DIR || '',
  ].filter(Boolean);
  for (const base of candidates) {
    const mod = tryFrom(base);
    if (mod) return mod;
  }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    const mod = tryFrom(root);
    if (mod) return mod;
  } catch { /* нет npm — не критично */ }
  return null;
}

const pw = loadPlaywright();
if (!pw || !pw.chromium) {
  console.error('Не найден playwright. Установи его в проект (npm i playwright) или задай PLAYWRIGHT_DIR.');
  process.exit(1);
}
const chromium = pw.chromium;

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes('--' + name);

const site = arg('url');
if (!site) { console.error('Укажи --url'); process.exit(1); }
const host = new URL(site).host;
const outDir = arg('out-dir', process.cwd());
const here = dirname(fileURLToPath(import.meta.url));
const profile = arg('profile', join(here, '..', 'pw-profile'));
const headless = !has('headful');
const waitCaptcha = parseInt(arg('wait', '120'), 10);
mkdirSync(outDir, { recursive: true });

const query = encodeURIComponent('site:' + host);
const ENGINES = {
  yandex: {
    url: `https://yandex.ru/search/?text=${query}`,
    ready: 'li.serp-item, .serp-item, .Organic',
    captcha: /captcha|вы не робот|верификац|подтвердите/i,
    items: 'li.serp-item, .serp-item',
    title: 'h3, .OrganicTitle-Link, .organic__url-text',
    link: 'a.OrganicTitle-Link, a.organic__url, h2 a, a[href^="http"]',
    snippet: '.OrganicText, .TextContainer, .organic__content-wrapper',
  },
  google: {
    url: `https://www.google.com/search?q=${query}&hl=ru&num=30`,
    ready: '#search, div#rso',
    captcha: /unusual traffic|captcha|нажмите здесь|enablejs|наши системы/i,
    items: '#search div.g, div#rso > div',
    title: 'h3',
    link: 'a[href^="http"]',
    snippet: '.VwiC3b, .IsZvec, .lyLwlc',
  },
};

const result = { host, capturedAt: new Date().toISOString(), yandex: {}, google: {} };

const ctx = await chromium.launchPersistentContext(profile, {
  headless,
  viewport: { width: 1366, height: 1600 },
  locale: 'ru-RU',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
});

for (const name of Object.keys(ENGINES)) {
  const eng = ENGINES[name];
  const info = { url: eng.url, captcha: false, results: [] };
  const page = await ctx.newPage();
  try {
    await page.goto(eng.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // ждём результаты или капчу
    let waited = 0;
    while (waited < waitCaptcha * 1000) {
      const html = await page.content();
      if (eng.captcha.test(html) || await page.$('input[name="captcha"], .captcha, #captcha, form[action*="captcha"]')) {
        info.captcha = true;
        if (waited === 0) console.log(`[${name}] показана капча/верификация — пройди её в окне браузера (жду ${waitCaptcha}с)…`);
        await page.waitForTimeout(4000);
        waited += 4000;
        continue;
      }
      if (await page.$(eng.ready.split(',')[0].trim()) || (await page.content()).length > 20000) break;
      await page.waitForTimeout(2000);
      waited += 2000;
    }
    await page.waitForTimeout(1500);

    // скриншот выдачи
    const shot = join(outDir, `serp_${name}.png`);
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    info.screenshot = shot.split(/[\\/]/).pop();

    // парсинг результатов
    const items = await page.$$(eng.items);
    for (const it of items) {
      try {
        const title = (await it.$eval(eng.title, (e) => e.textContent).catch(() => '')) || '';
        let href = (await it.$eval(eng.link, (e) => e.href).catch(() => '')) || '';
        const snip = (await it.$eval(eng.snippet, (e) => e.textContent).catch(() => '')) || '';
        if (!href && !title) continue;
        // Google: ссылки бывают /url?q=
        const m = href.match(/[?&]q=([^&]+)/);
        if (m) href = decodeURIComponent(m[1]);
        if (!/^https?:/.test(href)) continue;
        if (!href.includes(host.replace('www.', ''))) continue;
        info.results.push({ title: title.trim(), url: href, snippet: snip.replace(/\s+/g, ' ').trim() });
        if (info.results.length >= 15) break;
      } catch { /* ignore */ }
    }
    // скриншоты первых проблемных результатов (2–4)
    const cards = (await page.$$(eng.items)).slice(0, 4);
    for (let i = 0; i < cards.length; i++) {
      const f = join(outDir, `serp_${name}_card${i + 1}.png`);
      await cards[i].screenshot({ path: f }).catch(() => {});
      if (info.results[i]) info.results[i].screenshot = f.split(/[\\/]/).pop();
    }
  } catch (e) {
    info.error = String(e.message || e);
  }
  result[name] = info;
  await page.close();
}

writeFileSync(join(outDir, 'serp.json'), JSON.stringify(result, null, 2), 'utf-8');
console.log('Готово. serp.json:');
for (const name of Object.keys(ENGINES)) {
  const r = result[name];
  console.log(`  ${name}: результатов ${r.results.length}${r.captcha ? ' (капча)' : ''}${r.error ? ' ошибка: ' + r.error : ''}`);
}
await ctx.close();
