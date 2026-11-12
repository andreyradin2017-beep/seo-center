#!/usr/bin/env python3
"""Сборка итогового XLSX по постам из JSON, собранного collect.js.

Колонки и их порядок берутся из fields.json.
Результат: лист «Посты» (по одному посту в строке) и лист «Сводка» по группам.
"""

import argparse
import json
import sys
from collections import OrderedDict

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font, Alignment, PatternFill
    from openpyxl.utils import get_column_letter
except ImportError:
    print("Не найден openpyxl. Установите: pip3 install --break-system-packages openpyxl", file=sys.stderr)
    sys.exit(2)


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def fmt(value):
    if value is None:
        return ""
    return value


def build(rows, fields, out_path):
    wb = Workbook()
    ws = wb.active
    ws.title = "Посты"

    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill("solid", fgColor="4F8CFF")
    header_align = Alignment(horizontal="center", vertical="center", wrap_text=True)

    headers = [f["title"] for f in fields]
    ws.append(headers)
    for col, _ in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=col)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = header_align
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}1"

    for row in rows:
        ws.append([fmt(row.get(f["key"])) for f in fields])

    # Ширина колонок по заголовку и первым строкам (ограниченно).
    widths = {}
    for i, f in enumerate(fields, start=1):
        longest = len(f["title"]) + 2
        for r in ws.iter_rows(min_row=2, max_row=min(ws.max_row, 200), min_col=i, max_col=i):
            for c in r:
                if c.value is not None:
                    longest = max(longest, min(len(str(c.value)), 60) + 2)
        widths[i] = min(longest, 70)
    for i, w in widths.items():
        ws.column_dimensions[get_column_letter(i)].width = w

    # Текст поста и хештеги — переносом, дата по центру.
    key_to_col = {f["key"]: i + 1 for i, f in enumerate(fields)}
    if "text" in key_to_col:
        for r in ws.iter_rows(min_row=2, min_col=key_to_col["text"], max_col=key_to_col["text"]):
            for c in r:
                c.alignment = Alignment(wrap_text=True, vertical="top")
    if "published_at" in key_to_col:
        for r in ws.iter_rows(min_row=2, min_col=key_to_col["published_at"], max_col=key_to_col["published_at"]):
            for c in r:
                c.alignment = Alignment(horizontal="center")

    # ── Сводка по группам ──
    ws2 = wb.create_sheet("Сводка")
    ws2.append(["Площадка", "Группа", "Ссылка на группу", "Постов",
                "Лайки", "Репосты", "Комментарии", "Просмотры всего", "Голоса",
                "Первая публикация", "Последняя публикация"])
    for col in range(1, 12):
        cell = ws2.cell(row=1, column=col)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = header_align

    groups = OrderedDict()
    for row in rows:
        key = (row.get("platform"), row.get("group"), row.get("group_url"))
        groups.setdefault(key, []).append(row)

    def total(items, field):
        vals = [it.get(field) for it in items if isinstance(it.get(field), (int, float))]
        return int(sum(vals)) if vals else ""

    for (platform, group, url), items in groups.items():
        dates = sorted([it.get("published_at") for it in items if it.get("published_at")])
        ws2.append([
            platform or "", group or "", url or "", len(items),
            total(items, "likes"), total(items, "reposts"), total(items, "comments"),
            total(items, "views_total"), total(items, "votes"),
            dates[0] if dates else "", dates[-1] if dates else "",
        ])

    for i, w in enumerate([10, 24, 42, 8, 10, 10, 13, 15, 10, 18, 18], start=1):
        ws2.column_dimensions[get_column_letter(i)].width = w
    ws2.freeze_panes = "A2"

    wb.save(out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", required=True)
    ap.add_argument("--fields", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    rows = load_json(args.rows)
    fields = load_json(args.fields)
    if not isinstance(rows, list):
        rows = []
    build(rows, fields, args.out)
    print(f"XLSX сохранён: {args.out} (строк: {len(rows)})")


if __name__ == "__main__":
    main()
