#!/usr/bin/env python3
"""Читает файл ТЗ/тем и печатает его текст в stdout.

Поддерживает: .odt, .docx, .xlsx, .xls, .txt, .md, .csv, .tsv.
Для .odt читает content.xml из zip-контейнера (без внешних зависимостей).
Для .docx использует python-docx (если установлен), иначе — грубый парсер XML.
Для .xlsx/.xls использует openpyxl (если установлен).

Использование:
    python3 read_topic_file.py "/path/to/тз.odt"
    python3 read_topic_file.py "/path/to/Темы_для_блога_site.xlsx"
"""
import sys
import os
import re
import html
import zipfile
import csv as _csv


def _clean(text: str) -> str:
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def read_odt(path: str) -> str:
    with zipfile.ZipFile(path) as z:
        xml = z.read("content.xml").decode("utf-8", "ignore")
    xml = re.sub(r"<text:h[^>]*>", "\n\n", xml)
    xml = re.sub(r"</text:h>", "\n", xml)
    xml = re.sub(r"<text:p[^>]*>", "\n", xml)
    xml = re.sub(r"</text:p>", "\n", xml)
    xml = re.sub(r"<text:line-break[^>]*/>", "\n", xml)
    xml = re.sub(r"<text:tab[^>]*/>", " | ", xml)
    xml = re.sub(r"<text:s[^>]*/>", " ", xml)
    xml = re.sub(r"<[^>]+>", "", xml)
    return _clean(html.unescape(xml))


def read_docx(path: str) -> str:
    try:
        import docx  # type: ignore
    except Exception:
        docx = None
    if docx is not None:
        d = docx.Document(path)
        return _clean("\n".join(p.text for p in d.paragraphs))
    # fallback: parse word/document.xml
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8", "ignore")
    xml = re.sub(r"</w:p>", "\n", xml)
    xml = re.sub(r"<[^>]+>", "", xml)
    return _clean(html.unescape(xml))


def read_plain(path: str) -> str:
    with open(path, encoding="utf-8", errors="ignore") as f:
        return _clean(f.read())


def read_xlsx(path: str) -> str:
    """Читает .xlsx/.xls и печатает как TSV-подобный текст (колонки — через таб).

    Для таблицы тем (Темы_для_блога_*.xlsx) колонки: Название статьи | Структура |
    Запросы из сем ядра. Они выводятся построчно с полями через табуляцию, чтобы
    навык `seo-articles` мог извлечь тему, структуру и ключевые слова.
    """
    try:
        from openpyxl import load_workbook  # type: ignore
    except Exception as e:
        raise RuntimeError(
            "для чтения .xlsx нужен openpyxl (pip install openpyxl): " + str(e)
        )
    wb = load_workbook(path, read_only=True, data_only=True)
    lines = []
    for ws in wb.worksheets:
        for row in ws.iter_rows(values_only=True):
            cells = ["" if c is None else str(c) for c in row]
            # полностью пустые строки пропускаем
            if not any(c.strip() for c in cells):
                continue
            # многострочные ячейки (структура/запросы) сохраняем как есть —
            # они уже разделены переводами строк внутри значения
            lines.append("\t".join(cells))
    wb.close()
    return _clean("\n".join(lines))


def read_csv_tsv(path: str) -> str:
    """CSV/TSV читаем через csv-модуль: многострочные ячейки в кавычках
    разворачиваем как есть, разделителем вывода делаем табуляцию."""
    with open(path, encoding="utf-8-sig", errors="ignore", newline="") as f:
        sample = f.read(4096)
        f.seek(0)
        delim = ";" if sample.count(";") >= sample.count(",") else ","
        rows = list(_csv.reader(f, delimiter=delim))
    out = []
    for row in rows:
        if not any((c or "").strip() for c in row):
            continue
        out.append("\t".join(c or "" for c in row))
    return _clean("\n".join(out))


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: read_topic_file.py <file>", file=sys.stderr)
        return 2
    path = sys.argv[1]
    if not os.path.exists(path):
        print(f"file not found: {path}", file=sys.stderr)
        return 1
    ext = os.path.splitext(path)[1].lower()
    if ext == ".odt":
        text = read_odt(path)
    elif ext == ".docx":
        text = read_docx(path)
    elif ext in (".xlsx", ".xls"):
        try:
            text = read_xlsx(path)
        except RuntimeError as e:
            print(str(e), file=sys.stderr)
            return 1
    elif ext in (".csv", ".tsv"):
        text = read_csv_tsv(path)
    elif ext in (".txt", ".md", ".markdown"):
        text = read_plain(path)
    else:
        print(f"unsupported extension: {ext}", file=sys.stderr)
        return 1
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
