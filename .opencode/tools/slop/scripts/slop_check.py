#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""slop_check.py — проверить документ (docx/xlsx/txt/md) на AI-маркеры (stop-slop-ru).

Извлекает текст из файла и прогоняет линтер scripts/stopslop.py.

Примеры:
    python3 .opencode/tools/slop/scripts/slop_check.py "SEO-аудит.docx"
    python3 .opencode/tools/slop/scripts/slop_check.py "SEO-аудит.docx" --severity high
    python3 .opencode/tools/slop/scripts/slop_check.py "SEO-аудит.docx" --min-score 20

Код возврата: как у stopslop.py (при --min-score N — 1, если срабатываний больше N).
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
STOPSLOP = os.path.join(HERE, "stopslop.py")


def extract(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in (".docx", ".doc"):
        from docx import Document
        d = Document(path)
        parts = [p.text for p in d.paragraphs]
        for t in d.tables:
            for r in t.rows:
                parts.append(" | ".join(c.text for c in r.cells))
        return "\n".join(parts)
    if ext in (".xlsx", ".xls"):
        from openpyxl import load_workbook
        wb = load_workbook(path, read_only=True, data_only=True)
        out = []
        for ws in wb.worksheets:
            out.append("## " + ws.title)
            for row in ws.iter_rows(values_only=True):
                out.append(" | ".join("" if c is None else str(c) for c in row))
        return "\n".join(out)
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: slop_check.py <file.docx|.xlsx|.txt|.md> [stopslop args]")
        return 2
    path = sys.argv[1]
    rest = sys.argv[2:]
    if not os.path.exists(path):
        print("Файл не найден:", path)
        return 2
    text = extract(path)
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as f:
        f.write(text)
        tmp = f.name
    try:
        return subprocess.run([sys.executable, STOPSLOP, tmp] + rest).returncode
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
