// Разбор шаблона-эталона .odt в плоский текст (структура, заголовки, таблицы).
// Использование: node odt-to-text.mjs <file.odt> [out.txt]
import AdmZip from 'adm-zip';
import fs from 'fs';

const src = process.argv[2];
const out = process.argv[3] || src.replace(/\.odt$/i, '.txt');
if (!src) { console.error('Укажи путь к .odt'); process.exit(1); }

const zip = new AdmZip(src);
const entry = zip.getEntry('content.xml');
if (!entry) { console.error('content.xml не найден — это точно .odt?'); process.exit(1); }
const xml = entry.getData().toString('utf8');

const unescape = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const bodyMatch = xml.match(/<office:body[\s\S]*?<office:text[\s\S]*?>([\s\S]*)<\/office:text>/);
const body = bodyMatch ? bodyMatch[1] : xml;

const lines = [];
const re = /<text:(p|h)\b[^>]*>([\s\S]*?)<\/text:\1>|<table:table[\s\S]*?<\/table:table>/g;
let m;
while ((m = re.exec(body)) !== null) {
  if (m[0].startsWith('<table:table')) {
    const table = m[0];
    const rows = [];
    const rowRe = /<table:table-row[\s\S]*?<\/table:table-row>/g;
    let rm;
    while ((rm = rowRe.exec(table)) !== null) {
      const cells = [];
      const cellRe = /<table:table-cell[\s\S]*?<\/table:table-cell>|<table:table-cell[^>]*\/>/g;
      let cm;
      while ((cm = cellRe.exec(rm[0])) !== null) {
        const parts = [];
        const tRe = /<text:p\b[^>]*>([\s\S]*?)<\/text:p>|<text:p\b[^>]*\/>/g;
        let tm;
        while ((tm = tRe.exec(cm[0])) !== null) parts.push(tm[1] !== undefined ? unescape(tm[1].replace(/<[^>]+>/g, '')) : '');
        cells.push(parts.join(' / '));
      }
      rows.push('| ' + cells.join(' | ') + ' |');
    }
    lines.push('[TABLE]', ...rows, '[/TABLE]');
  } else {
    const text = unescape(m[2].replace(/<text:tab[^>]*\/>/g, '\t').replace(/<text:line-break[^>]*\/>/g, '\n').replace(/<[^>]+>/g, ''));
    lines.push((m[1] === 'h' ? '\n### ' : '') + text);
  }
}
fs.writeFileSync(out, lines.join('\n\n'), 'utf8');
console.log('Готово:', out, '| строк:', lines.length);
