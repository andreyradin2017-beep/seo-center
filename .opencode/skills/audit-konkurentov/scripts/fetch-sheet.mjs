// Выгрузка и разбор вкладки Google Sheets-таблицы (аудит конкурентов).
// Использование:
//   node fetch-sheet.mjs "<url|id>" ["Название вкладки"] [--out <dir>]
// Без названия вкладки — печатает список вкладок.
import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
let out = '.';
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') { out = args[++i]; } else { positional.push(args[i]); }
}
const src = positional[0];
const tab = positional[1];

if (!src) { console.error('Укажи ссылку или ID таблицы.'); process.exit(1); }

const m = String(src).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
const id = m ? m[1] : src;

fs.mkdirSync(out, { recursive: true });
const xlsxPath = path.join(out, 'audit.xlsx');

const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`;
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) { console.error('Ошибка загрузки:', res.status, res.statusText); process.exit(1); }
fs.writeFileSync(xlsxPath, Buffer.from(await res.arrayBuffer()));
console.log('Скачано:', xlsxPath);

const wb = XLSX.readFile(xlsxPath);
console.log('\nВкладки:');
for (const name of wb.SheetNames) console.log('  -', name);

if (!tab) {
  console.log('\nУкажи название вкладки вторым аргументом, чтобы выгрузить её.');
  process.exit(0);
}
const ws = wb.Sheets[tab];
if (!ws) { console.error('\nВкладка не найдена:', tab); process.exit(1); }

const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false });
const txtLines = rows.map((r, i) => `[${i + 1}] ` + r.map((c) => String(c).replace(/\r?\n/g, ' / ').trim()).join(' | '));
const safe = tab.replace(/[^\p{L}\p{N} _-]/gu, '_');
fs.writeFileSync(path.join(out, `${safe}.txt`), txtLines.join('\n'), 'utf8');
fs.writeFileSync(path.join(out, `${safe}.csv`), XLSX.utils.sheet_to_csv(ws), 'utf8');
console.log('\nВыгружено:', path.join(out, `${safe}.txt`), '(', rows.length, 'строк )');
console.log('CSV:', path.join(out, `${safe}.csv`));
