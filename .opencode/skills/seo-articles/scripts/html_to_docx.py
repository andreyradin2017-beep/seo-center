#!/usr/bin/env python3
"""Конвертирует HTML тела материала в DOCX (python-docx).

Поддерживает: h1/h2/h3/h4, p, ul/ol/li, strong/b, em/i, mark (жёлтая подсветка),
a (гиперссылки), table/tr/td/th.

Использование:
    python3 html_to_docx.py input.html output.docx
Если output не указан, меняется расширение входного файла на .docx.
"""
import sys
import os
import re
from html.parser import HTMLParser

from docx import Document
from docx.enum.text import WD_COLOR_INDEX
from docx.oxml.ns import qn
from docx.oxml import OxmlElement


BLOCK_TAGS = {"h1", "h2", "h3", "h4", "p", "li"}
HEADING_LEVEL = {"h1": 1, "h2": 2, "h3": 3, "h4": 4}
INLINE_ON = {"strong": "bold", "b": "bold", "em": "italic", "i": "italic", "mark": "mark"}


def add_hyperlink(paragraph, url, text, bold=False, italic=False, highlight=False):
    part = paragraph.part
    r_id = part.relate_to(
        url,
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
        is_external=True,
    )
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), r_id)
    new_run = OxmlElement("w:r")
    rPr = OxmlElement("w:rPr")
    if bold:
        rPr.append(OxmlElement("w:b"))
    if italic:
        rPr.append(OxmlElement("w:i"))
    if highlight:
        hl = OxmlElement("w:highlight")
        hl.set(qn("w:val"), "yellow")
        rPr.append(hl)
    color = OxmlElement("w:color")
    color.set(qn("w:val"), "0563C1")
    rPr.append(color)
    underline = OxmlElement("w:u")
    underline.set(qn("w:val"), "single")
    rPr.append(underline)
    new_run.append(rPr)
    t = OxmlElement("w:t")
    t.text = text
    new_run.append(t)
    hyperlink.append(new_run)
    paragraph._p.append(hyperlink)


def normalize_runs(runs):
    """Collapse source-formatting whitespace and trim the block edges."""
    items = []
    for r in runs:
        text = re.sub(r"\s+", " ", r["text"])
        if text:
            items.append({**r, "text": text})
    while items and not items[0]["text"].strip():
        items.pop(0)
    while items and not items[-1]["text"].strip():
        items.pop()
    if items:
        items[0]["text"] = items[0]["text"].lstrip()
        items[-1]["text"] = items[-1]["text"].rstrip()
    return [r for r in items if r["text"]]


def emit_runs(paragraph, runs):
    for r in normalize_runs(runs):
        if r.get("href"):
            add_hyperlink(
                paragraph,
                r["href"],
                r["text"],
                r.get("bold", False),
                r.get("italic", False),
                r.get("mark", False),
            )
        else:
            run = paragraph.add_run(r["text"])
            run.bold = r.get("bold", False)
            run.italic = r.get("italic", False)
            if r.get("mark"):
                run.font.highlight_color = WD_COLOR_INDEX.YELLOW


class DocxParser(HTMLParser):
    """Collects an ordered list of blocks; tables stay in document order."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = []  # ("para", kind, runs, list_kind) | ("table", rows)
        self.cur_kind = None
        self._list_kind = None
        self.runs = []
        self.bold = 0
        self.italic = 0
        self.mark = 0
        self.href = []
        self.list_stack = []
        self.in_table = False
        self.cur_row = None
        self.cur_cell = None
        self.rows = []

    def _run(self, text):
        return {
            "text": text,
            "bold": self.bold > 0,
            "italic": self.italic > 0,
            "mark": self.mark > 0,
            "href": self.href[-1] if self.href else None,
        }

    def _add_run(self, text):
        if text:
            self.runs.append(self._run(text))

    def _add_cell_run(self, text):
        if text and self.cur_cell is not None:
            self.cur_cell.append(self._run(text))

    def _flush_block(self):
        if self.cur_kind is not None:
            self.blocks.append(("para", self.cur_kind, self.runs, self._list_kind))
            self.runs = []
            self.cur_kind = None
            self._list_kind = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if self.in_table:
            if tag == "tr":
                self.cur_row = []
            elif tag in ("td", "th"):
                self.cur_cell = []
            elif tag in INLINE_ON:
                setattr(self, INLINE_ON[tag], getattr(self, INLINE_ON[tag]) + 1)
            elif tag == "br":
                self._add_cell_run("\n")
            return
        if tag == "table":
            self._flush_block()
            self.in_table = True
            self.rows = []
            self.cur_row = None
            self.cur_cell = None
        elif tag in BLOCK_TAGS:
            self._flush_block()
            self.cur_kind = tag
            self._list_kind = self.list_stack[-1] if self.list_stack else "ul"
        elif tag in INLINE_ON:
            setattr(self, INLINE_ON[tag], getattr(self, INLINE_ON[tag]) + 1)
        elif tag == "a":
            self.href.append(a.get("href", ""))
        elif tag in ("ul", "ol"):
            self._flush_block()
            self.list_stack.append(tag)
        elif tag == "br":
            self._add_run("\n")

    def handle_endtag(self, tag):
        if self.in_table:
            if tag in ("td", "th"):
                if self.cur_row is not None and self.cur_cell is not None:
                    self.cur_row.append(self.cur_cell)
                self.cur_cell = None
            elif tag == "tr":
                if self.cur_row is not None:
                    self.rows.append(self.cur_row)
                self.cur_row = None
            elif tag == "table":
                self._flush_block()
                if self.rows:
                    self.blocks.append(("table", self.rows))
                self.in_table = False
                self.rows = []
            elif tag in INLINE_ON:
                key = INLINE_ON[tag]
                setattr(self, key, max(0, getattr(self, key) - 1))
            return
        if tag in BLOCK_TAGS:
            self._flush_block()
        elif tag in INLINE_ON:
            key = INLINE_ON[tag]
            setattr(self, key, max(0, getattr(self, key) - 1))
        elif tag == "a":
            if self.href:
                self.href.pop()
        elif tag in ("ul", "ol"):
            self._flush_block()
            if self.list_stack:
                self.list_stack.pop()

    def handle_data(self, data):
        if self.in_table:
            self._add_cell_run(data)
            return
        self._add_run(data)

    def build(self):
        doc = Document()
        for item in self.blocks:
            if item[0] == "table":
                rows = item[1]
                cols = max(len(r) for r in rows)
                table = doc.add_table(rows=len(rows), cols=cols)
                table.style = "Table Grid"
                for i, row in enumerate(rows):
                    for j in range(cols):
                        cell = table.cell(i, j)
                        runs = row[j] if j < len(row) else []
                        emit_runs(cell.paragraphs[0], runs)
                continue

            _, kind, runs, list_kind = item
            if kind in HEADING_LEVEL:
                p = doc.add_heading("", level=HEADING_LEVEL[kind])
            elif kind == "li":
                style = "List Number" if list_kind == "ol" else "List Bullet"
                p = doc.add_paragraph(style=style)
            else:
                p = doc.add_paragraph()
            emit_runs(p, runs)
        return doc


def convert(html_text: str) -> Document:
    parser = DocxParser()
    parser.feed(html_text)
    parser._flush_block()
    return parser.build()


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: html_to_docx.py input.html [output.docx]", file=sys.stderr)
        return 2
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else re.sub(r"\.[^.]+$", "", src) + ".docx"
    with open(src, encoding="utf-8") as f:
        html_text = f.read()
    convert(html_text).save(dst)
    print(dst)
    return 0


if __name__ == "__main__":
    sys.exit(main())
