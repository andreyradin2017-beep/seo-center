#!/usr/bin/env python3
"""to_xlsx.py — конвертация итоговой CSV-таблицы тем в XLSX.

Использование:
    python3 to_xlsx.py <input.csv> <output.xlsx>

Особенности:
- чтение CSV с разделителем ';' и BOM (utf-8-sig);
- многострочные ячейки сохраняются (перенос строк включён);
- авто-ширина колонок (с разумным лимитом);
- заголовок выделен жирным, заморожен.
Требует openpyxl. Если его нет — вызывающий код использует LibreOffice.
"""
import csv
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: to_xlsx.py <input.csv> <output.xlsx>", file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]

    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill
        from openpyxl.utils import get_column_letter
    except ImportError:
        print("openpyxl недоступен", file=sys.stderr)
        return 3

    with open(src, "r", encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f, delimiter=";"))

    wb = Workbook()
    ws = wb.active
    ws.title = "Темы"

    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill("solid", fgColor="4F8CFF")
    wrap = Alignment(wrap_text=True, vertical="top")

    ncols = max(len(r) for r in rows) if rows else 1
    widths = [0] * ncols
    col_caps = [58, 46, 34]

    for ri, row in enumerate(rows):
        max_lines = 1
        for ci, val in enumerate(row):
            cell = ws.cell(row=ri + 1, column=ci + 1, value=val)
            cell.alignment = wrap
            if ri == 0:
                cell.font = header_font
                cell.fill = header_fill
            text = str(val)
            longest = max((len(ln) for ln in text.split("\n")), default=0)
            cap = col_caps[ci] if ci < len(col_caps) else 40
            widths[ci] = max(widths[ci], min(longest, cap, 70))
            if ri > 0:
                max_lines = max(max_lines, text.count("\n") + 1)
        if ri > 0:
            ws.row_dimensions[ri + 1].height = min(max(18, max_lines * 14), 240)

    for ci, w in enumerate(widths):
        cap = col_caps[ci] if ci < len(col_caps) else 40
        ws.column_dimensions[get_column_letter(ci + 1)].width = max(14, min(w + 2, cap))

    ws.freeze_panes = "A2"
    wb.save(dst)
    print(f"XLSX сохранён: {dst} ({len(rows)} строк)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
