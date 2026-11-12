#!/usr/bin/env node
// Вставка HTML-блоков (сделанных make-block.mjs) в Google Sheets через CDP.
// Требует запущенного Chrome с профилем пользователя (см. browser-session.sh).
//
// Использование:
//   node scripts/paste-blocks.mjs \
//     --cdp http://127.0.0.1:9222 \
//     --sheet "https://docs.google.com/spreadsheets/d/<ID>/edit" \
//     --tab "Покраска металлоизделий" \
//     --block "B38:/tmp/blk_38.html" \
//     --block "B41:/tmp/blk_41.html"
//
// --block можно указывать много раз. Ячейка = первая ячейка блока
// (левая верхняя, обычно столбец B строки с подписью в колонке A).
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  const candidates = [
    'playwright-core',
    'playwright',
    process.env.PLAYWRIGHT_PATH,
  ].filter(Boolean);
  // поднимаемся по дереву в поисках node_modules/(playwright-core|playwright)
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, 'node_modules', 'playwright-core'));
    candidates.push(path.join(dir, 'node_modules', 'playwright'));
    dir = path.dirname(dir);
  }
  for (const c of candidates) {
    try { return require(c); } catch { /* next */ }
  }
  throw new Error('Не найден playwright-core/playwright. Установи в папке навыка (npm install) или задай PLAYWRIGHT_PATH.');
}

function parseArgs(argv) {
  const args = { cdp: 'http://127.0.0.1:9222', blocks: [], verify: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cdp') args.cdp = argv[++i];
    else if (a === '--sheet') args.sheet = argv[++i];
    else if (a === '--tab') args.tab = argv[++i];
    else if (a === '--block') args.blocks.push(argv[++i]);
    else if (a === '--verify') args.verify.push(...String(argv[++i]).split(',').map(s => s.trim()).filter(Boolean));
  }
  return args;
}

const { chromium } = loadPlaywright();
const args = parseArgs(process.argv.slice(2));

if (!args.sheet || !args.blocks.length) {
  console.error('Нужны --sheet и хотя бы один --block "CELL:FILE"');
  process.exit(1);
}

const jobs = args.blocks.map((b) => {
  const idx = b.indexOf(':');
  return { cell: b.slice(0, idx).trim(), file: b.slice(idx + 1).trim() };
});
for (const j of jobs) {
  if (!fs.existsSync(j.file)) { console.error('Нет файла блока:', j.file); process.exit(1); }
}

(async () => {
  const browser = await chromium.connectOverCDP(args.cdp);
  const ctx = browser.contexts()[0];
  const sheet = await ctx.newPage();
  await sheet.goto(args.sheet, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sheet.waitForTimeout(15000);
  await sheet.bringToFront();

  if (args.tab) {
    try { await sheet.getByText(args.tab, { exact: true }).last().click({ timeout: 8000 }); }
    catch { console.error('Не удалось кликнуть вкладку:', args.tab); }
    await sheet.waitForTimeout(3000);
    const active = await sheet.evaluate(() =>
      (Array.from(document.querySelectorAll('.docs-sheet-tab')).find((e) => /active/.test(e.className)) || {}).textContent?.trim() || null);
    console.log('Активная вкладка:', active);
    if (active && !active.includes(args.tab)) { console.error('Вкладка не совпала — прерываю.'); await browser.close(); process.exit(1); }
  }

  const selectCell = async (a) => {
    const nb = sheet.locator('#t-name-box');
    await nb.click();
    await sheet.keyboard.press('Control+A');
    await sheet.keyboard.type(a);
    await sheet.keyboard.press('Enter');
    await sheet.waitForTimeout(800);
  };

  for (const j of jobs) {
    const hp = await ctx.newPage();
    await hp.goto('file://' + path.resolve(j.file), { waitUntil: 'load', timeout: 30000 });
    await hp.waitForTimeout(800);
    await hp.bringToFront();
    await hp.mouse.click(300, 200).catch(() => {});
    await hp.keyboard.press('Control+A');
    await hp.keyboard.press('Control+C');
    await hp.waitForTimeout(1000);
    await sheet.bringToFront();
    await sheet.waitForTimeout(1200);
    await selectCell(j.cell);
    await sheet.keyboard.press('Control+V');
    await sheet.waitForTimeout(4000);
    console.log('Вставлено в', j.cell, '<-', path.basename(j.file));
    await hp.close();
  }

  for (const a of args.verify) {
    await selectCell(a);
    const v = await sheet.evaluate(() => {
      const el = document.querySelector('#t-formula-bar-input');
      return el ? el.textContent : null;
    });
    console.log('ПРОВЕРКА', a, '=>', JSON.stringify(v).slice(0, 120));
  }

  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
