#!/usr/bin/env node
// JSON -> HTML-таблица для вставки в Google Sheets.
// Перенос строки внутри ячейки (\n в JSON) сохраняется как перенос в ячейке (<br>).
//
// Использование:
//   node scripts/make-block.mjs <input.json> <output.html>
//
// Формат input.json — массив строк, каждая строка — массив ячеек (по столбцам):
//   [
//     ["строка1, колонка B", "строка1, колонка C", ...],
//     ["строка2, колонка B", "строка2, колонка C", ...]
//   ]
import fs from 'node:fs';

const [, , inFile, outFile] = process.argv;
if (!inFile || !outFile) {
  console.error('Использование: node scripts/make-block.mjs <input.json> <output.html>');
  process.exit(1);
}

const rows = JSON.parse(fs.readFileSync(inFile, 'utf8'));
if (!Array.isArray(rows)) throw new Error('JSON должен быть массивом строк');

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const trs = rows
  .map((cells) => {
    const tds = (Array.isArray(cells) ? cells : [cells])
      .map((c) => '<td>' + esc(c).replace(/\r?\n/g, '<br>') + '</td>')
      .join('');
    return '<tr>' + tds + '</tr>';
  })
  .join('\n');

const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><table border="0">\n${trs}\n</table></body></html>\n`;
fs.writeFileSync(outFile, html, 'utf8');
console.log('OK:', outFile, '(' + rows.length + ' строк)');
