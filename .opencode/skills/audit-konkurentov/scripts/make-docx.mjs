// Генератор записки по аудиту конкурентов (.docx) из content.json
// Использование: node make-docx.mjs content.json output.docx
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, PageBreak, ShadingType, ImageRun,
} from 'docx';
import fs from 'fs';
import path from 'path';

const FONT = 'Arial';
const SIZE = 22; // 11pt

const run = (text, o = {}) => new TextRun({
  text: String(text), bold: o.bold, italics: o.italics, size: o.size || SIZE, font: FONT,
});
const p = (text, o = {}) => new Paragraph({
  children: Array.isArray(text) ? text : [run(text, o)],
  spacing: { after: o.after != null ? o.after : 140, before: o.before || 0, line: 276 },
  alignment: o.align, heading: o.heading,
});
const h1 = (t) => new Paragraph({ children: [run(t, { bold: true, size: 30 })], heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 160 } });
const h2 = (t) => new Paragraph({ children: [run(t, { bold: true, size: 26 })], heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 120 } });
const h3 = (t) => new Paragraph({ children: [run(t, { bold: true, size: 23 })], heading: HeadingLevel.HEADING_3, spacing: { before: 160, after: 100 } });

function bullet(b) {
  const children = (b && typeof b === 'object')
    ? [run(b.lead + ' ', { bold: true }), run(b.text || '')]
    : [run(String(b))];
  return new Paragraph({ children, bullet: { level: 0 }, spacing: { after: 100, line: 276 } });
}
function numbered(n, title, body) {
  const out = [new Paragraph({ children: [run(`${n}. ${title}`, { bold: true })], spacing: { before: 140, after: 60, line: 276 } })];
  if (body) out.push(new Paragraph({ children: [run(body)], spacing: { after: 140, line: 276 }, alignment: AlignmentType.JUSTIFIED }));
  return out;
}

function pngSize(buf) { return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; }
function imageBlock(file, caption, screensDir) {
  const buf = fs.readFileSync(path.join(screensDir, file));
  const { w, h } = pngSize(buf);
  let width = 560;
  let height = Math.round((width * h) / w);
  const maxH = 440;
  if (height > maxH) { height = maxH; width = Math.round((maxH * w) / h); }
  const out = [new Paragraph({
    children: [new ImageRun({ data: buf, transformation: { width, height }, type: 'png' })],
    spacing: { before: 140, after: 40 },
  })];
  if (caption) out.push(new Paragraph({ children: [run(caption, { italics: true, size: 18 })], spacing: { after: 200 }, alignment: AlignmentType.CENTER }));
  return out;
}
const cell = (text, o = {}) => new TableCell({
  width: o.width ? { size: o.width, type: WidthType.DXA } : undefined,
  shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill } : undefined,
  margins: { top: 60, bottom: 60, left: 100, right: 100 },
  children: [new Paragraph({ children: [run(text, { bold: o.bold, size: o.size || 20 })], alignment: o.align, spacing: { after: 0, line: 240 } })],
});
const BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
  left: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
  right: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
};

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const outPath = process.argv[3];
const SCREENS = cfg.screensDir;
const img = (file, caption) => imageBlock(file, caption, SCREENS);

const children = [];

// ---- Cover ----
const cover = cfg.cover || {};
if (cover.topLine) children.push(new Paragraph({ children: [run(cover.topLine, { bold: true, size: 32 })], spacing: { after: 260 } }));
if (Array.isArray(cover.table) && cover.table.length) {
  const rows = [new TableRow({ children: [cell(cover.table[0].label || '', { bold: true, width: 2200 }), cell(cover.table[0].value || '', { width: 6800 })] })];
  for (const r of cover.table) rows.push(new TableRow({ children: [cell(r.label || '', { bold: true, width: 2200 }), cell(r.value || '', { width: 6800 })] }));
  children.push(new Table({ width: { size: 9000, type: WidthType.DXA }, columnWidths: [2200, 6800], borders: BORDERS, rows: rows.slice(1) }));
}
children.push(new Paragraph({ children: [run('')], spacing: { after: 600 } }));
if (cover.title) children.push(new Paragraph({ children: [run(cover.title, { bold: true, size: 30 })], spacing: { after: 260 } }));
if (cover.date) children.push(p(cover.date));
if (cover.copyright) children.push(p(cover.copyright));
if (cover.disclaimer) children.push(p(cover.disclaimer, { size: 18 }));
children.push(new Paragraph({ children: [new PageBreak()] }));

// ---- TOC ----
children.push(h1(cfg.tocHeading || 'Содержание'));
children.push(p(cfg.tocLead || 'Оглавление', { bold: true }));
for (const line of (cfg.toc || [])) children.push(p(line));
children.push(new Paragraph({ children: [new PageBreak()] }));

// ---- Section 1 ----
const s1 = cfg.section1 || {};
if (s1.heading) children.push(h1(s1.heading));
if (s1.intro) children.push(p(s1.intro));
for (const c of (s1.competitors || [])) children.push(bullet(c));
if (s1.studiedLead) children.push(p(s1.studiedLead, { before: 120 }));
for (const c of (s1.studied || [])) children.push(bullet(c));
if (s1.tableNote) children.push(p(s1.tableNote, { before: 120 }));
if (s1.summaryTable && s1.summaryTable.headers) {
  if (s1.summaryTable.caption) children.push(h3(s1.summaryTable.caption));
  const headers = s1.summaryTable.headers;
  const nCol = headers.length;
  const first = 2900, rest = Math.floor((9200 - first) / (nCol - 1));
  const colW = headers.map((_, i) => (i === 0 ? first : rest));
  const rows = [new TableRow({ tableHeader: true, children: headers.map((t, i) => cell(t, { width: colW[i], align: AlignmentType.CENTER, size: 18, fill: 'DDDDDD', bold: true })) })];
  for (const r of s1.summaryTable.rows) rows.push(new TableRow({ children: r.map((t, i) => cell(t, { width: colW[i], align: i === 0 ? AlignmentType.LEFT : AlignmentType.CENTER, size: 18 })) }));
  children.push(new Table({ width: { size: 9200, type: WidthType.DXA }, columnWidths: colW, borders: BORDERS, rows }));
  children.push(p(''));
}
if (s1.conclusionsHeading) children.push(h3(s1.conclusionsHeading));
for (const c of (s1.conclusions || [])) children.push(bullet(c));
if (s1.marketHeading) children.push(h3(s1.marketHeading));
for (const c of (s1.market || [])) children.push(bullet(c));
children.push(new Paragraph({ children: [new PageBreak()] }));

// ---- Section 2 ----
const s2 = cfg.section2 || {};
if (s2.heading) children.push(h1(s2.heading));
for (const block of (s2.blocks || [])) {
  if (block.heading) children.push(h2(block.heading));
  if (block.intro) children.push(p(block.intro));
  let n = 0;
  for (const item of (block.items || [])) {
    n += 1;
    children.push(...numbered(n, item.title, item.body));
    for (const im of (item.images || [])) children.push(...img(im.file, im.caption));
  }
  for (const b of (block.bullets || [])) children.push(bullet(b));
  for (const im of (block.images || [])) children.push(...img(im.file, im.caption));
}

const doc = new Document({
  creator: cfg.creator || 'Текарт',
  title: cfg.title || 'Анализ конкурентов',
  styles: { default: { document: { run: { font: FONT, size: SIZE } } } },
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } } },
    children,
  }],
});
const buf = await Packer.toBuffer(doc);
fs.writeFileSync(outPath, buf);
console.log('Wrote', outPath, buf.length, 'bytes');
