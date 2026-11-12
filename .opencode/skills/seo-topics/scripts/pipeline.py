#!/usr/bin/env python3
"""pipeline.py — механическая часть навыка seo-topics одним вызовом.

Устраняет десятки мелких шагов модели: собирает финальные артефакты из уже
подготовленных данных. Сеть здесь НЕ используется (всё уже собрано ранее или
кладётся моделью), кроме чтения кэшей с диска.

Подкоманды:

  seed-wordstat   Засеять frequencies.tsv известными частотностями из мастер-кэша
                  (по тексту запроса, а не по индексу) перед вызовом wordstat-api.js.
      python3 pipeline.py seed-wordstat <master.tsv> <queries.tsv> <out_freq.tsv>

  save-wordstat   Слить собранные частотности обратно в мастер-кэш (по запросу).
      python3 pipeline.py save-wordstat <freq.tsv> <master.tsv>

  migrate-wordstat Построить мастер-кэш (query->freq) из прежних index-keyed файлов.
      python3 pipeline.py migrate-wordstat <master.tsv> <freq1.tsv> [freq2.tsv ...]

  build           Собрать итоговые CSV + XLSX из topics-candidates.json
                  (или topics-structured.json) и обновить used-topics.
      python3 pipeline.py build <topics.json> <outDir> <host> <used_topics.json>

  stagecheck      Печать прогресса по индексам frequencies.tsv (для отладки).
      python3 pipeline.py stagecheck <freq.tsv>

Форматы:
  topics.json  — массив {"topic": str, "structure": [str], "queries": [[kw, int], ...]}
  queries.tsv  — строки "idx \t тема \t запрос"
  master.tsv   — строки "запрос \t частота \t checked_at" (ключ — сам запрос)
  freq.tsv     — строки "idx \t запрос \t тема \t частота" (выход wordstat-api.js)
"""
import csv
import datetime
import json
import os
import sys

HOST_DEFAULT = "site"


def _is_num(v: str) -> bool:
    v = str(v).strip()
    return v.isdigit() or (v.startswith("-") and v[1:].isdigit())


def load_master(path: str) -> dict:
    """master.tsv -> {query: freq}."""
    out: dict[str, str] = {}
    if not path or not os.path.exists(path):
        return out
    for line in open(path, encoding="utf-8"):
        p = line.rstrip("\n").split("\t")
        if len(p) >= 2 and p[0].strip() and _is_num(p[1]):
            out[p[0]] = p[1]
    return out


def cmd_seed_wordstat(master_path: str, queries_path: str, out_path: str) -> int:
    known = load_master(master_path)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    rows = []
    for line in open(queries_path, encoding="utf-8"):
        p = line.rstrip("\n").split("\t")
        if len(p) < 3:
            continue
        idx, topic, kw = p[0], p[1], p[2]
        if kw in known:
            rows.append(f"{idx}\t{kw}\t{topic}\t{known[kw]}")
    open(out_path, "w", encoding="utf-8").write("\n".join(rows) + ("\n" if rows else ""))
    print(f"seed: {len(rows)} известных запросов -> {out_path}")
    return 0


def cmd_save_wordstat(freq_path: str, master_path: str) -> int:
    master = load_master(master_path)
    today = datetime.date.today().isoformat()
    added = updated = 0
    for line in open(freq_path, encoding="utf-8"):
        p = line.rstrip("\n").split("\t")
        if len(p) < 4:
            continue
        kw, freq = p[1], p[3]
        if not _is_num(freq):
            continue
        if kw in master:
            if master[kw] != freq:
                master[kw] = freq
                updated += 1
        else:
            master[kw] = freq
            added += 1
    os.makedirs(os.path.dirname(master_path) or ".", exist_ok=True)
    with open(master_path, "w", encoding="utf-8") as f:
        for kw in sorted(master):
            f.write(f"{kw}\t{master[kw]}\t{today}\n")
    print(f"master: +{added} новых, ~{updated} обновлено (всего {len(master)}) -> {master_path}")
    return 0


def cmd_migrate_wordstat(master_path: str, files: list[str]) -> int:
    master: dict[str, str] = {}
    for fp in files:
        if not os.path.exists(fp):
            continue
        for line in open(fp, encoding="utf-8"):
            p = line.rstrip("\n").split("\t")
            if len(p) < 4:
                continue
            kw, freq = p[1], p[3]
            if not _is_num(freq):
                continue
            if kw not in master or int(freq) > int(master[kw]):
                master[kw] = freq
    today = datetime.date.today().isoformat()
    os.makedirs(os.path.dirname(master_path) or ".", exist_ok=True)
    with open(master_path, "w", encoding="utf-8") as f:
        for kw in sorted(master):
            f.write(f"{kw}\t{master[kw]}\t{today}\n")
    print(f"master: {len(master)} запросов -> {master_path}")
    return 0


def num_fmt(n: int) -> str:
    return f"{int(n):,}".replace(",", " ")


def cmd_merge_wordstat(cache_path: str, out_path: str) -> int:
    if not os.path.exists(cache_path):
        print(f"кэш частотностей не найден: {cache_path}", file=sys.stderr)
        return 1
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    data = open(cache_path, encoding="utf-8").read()
    open(out_path, "w", encoding="utf-8").write(data)
    rows = [l for l in data.split("\n") if l.strip()]
    print(f"слито {len(rows)} записей: {cache_path} -> {out_path}")
    return 0


def cmd_stagecheck(freq_path: str) -> int:
    if not os.path.exists(freq_path):
        print(f"нет файла {freq_path}", file=sys.stderr)
        return 1
    total = nonzero = 0
    for line in open(freq_path, encoding="utf-8"):
        p = line.rstrip("\n").split("\t")
        if len(p) < 4:
            continue
        total += 1
        if p[3] not in ("0", "", "error", "auth_error") and not p[3].startswith("http"):
            nonzero += 1
    print(f"запросов: {total}, с частотностью: {nonzero}, нулевых: {total - nonzero}")
    return 0


def cmd_build(topics_path: str, out_dir: str, host: str, used_path: str | None) -> int:
    topics = json.load(open(topics_path, encoding="utf-8"))
    os.makedirs(out_dir, exist_ok=True)

    HEADER = ["Название статьи", "Структура", "Запросы из сем ядра"]
    rows = []
    for t in topics:
        structure = "\n".join(t.get("structure", []))
        queries = "\n".join(f"{k} {num_fmt(v)}" for k, v in t.get("queries", []))
        rows.append([t["topic"], structure, queries])

    # Build the exact CSV body: header row is ALWAYS first. Never emit the
    # XLSX from a headerless CSV.
    csv_path = os.path.join(out_dir, f"Темы_для_блога_{host}.csv")
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(HEADER)
        w.writerows(rows)
    print(f"CSV: {csv_path} ({len(rows)} тем)")

    xlsx_path = os.path.join(out_dir, f"Темы_для_блога_{host}.xlsx")
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill
        from openpyxl.utils import get_column_letter

        wb = Workbook()
        ws = wb.active
        ws.title = "Темы"
        header_font = Font(bold=True, color="FFFFFF")
        header_fill = PatternFill("solid", fgColor="4F8CFF")
        wrap = Alignment(wrap_text=True, vertical="top")
        widths = [0, 0, 0]
        # Column caps: topic wide, structure/queries moderately (they wrap).
        col_caps = [58, 46, 34]
        # Guarantee a header row in the XLSX regardless of input.
        all_rows = [HEADER] + rows
        for ri, row in enumerate(all_rows):
            max_lines = 1
            for ci, val in enumerate(row):
                c = ws.cell(row=ri + 1, column=ci + 1, value=val)
                c.alignment = wrap
                if ri == 0:
                    c.font = header_font
                    c.fill = header_fill
                text = str(val)
                # max character width in the cell (longest line) + line count
                longest = max((len(ln) for ln in text.split("\n")), default=0)
                lines = text.count("\n") + 1
                widths[ci] = max(widths[ci], min(longest, col_caps[ci], 70))
                if ri > 0:
                    max_lines = max(max_lines, lines)
            if ri > 0:
                # ~15px per wrapped line, capped so rows stay readable
                ws.row_dimensions[ri + 1].height = min(max(18, max_lines * 14), 240)
        for ci, wd in enumerate(widths):
            cap = col_caps[ci] if ci < len(col_caps) else 40
            ws.column_dimensions[get_column_letter(ci + 1)].width = max(14, min(wd + 2, cap))
        ws.freeze_panes = "A2"
        wb.save(xlsx_path)
        print(f"XLSX: {xlsx_path}")
    except ImportError:
        print("openpyxl недоступен — XLSX не создан", file=sys.stderr)

    if used_path:
        used = []
        if os.path.exists(used_path):
            try:
                used = json.load(open(used_path, encoding="utf-8"))
            except Exception:
                used = []
        existing = {u.get("topic") for u in used}
        added = 0
        for t in topics:
            if t["topic"] not in existing:
                used.append({
                    "topic": t["topic"],
                    "keywords": [k for k, _ in t.get("queries", [])],
                    "created_at": __import__("datetime").date.today().isoformat(),
                    "outDir": out_dir,
                })
                added += 1
        os.makedirs(os.path.dirname(used_path) or ".", exist_ok=True)
        json.dump(used, open(used_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"used-topics: +{added} (всего {len(used)})")
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    cmd = sys.argv[1]
    if cmd == "merge-wordstat" and len(sys.argv) >= 4:
        return cmd_merge_wordstat(sys.argv[2], sys.argv[3])
    if cmd == "seed-wordstat" and len(sys.argv) >= 5:
        return cmd_seed_wordstat(sys.argv[2], sys.argv[3], sys.argv[4])
    if cmd == "save-wordstat" and len(sys.argv) >= 4:
        return cmd_save_wordstat(sys.argv[2], sys.argv[3])
    if cmd == "migrate-wordstat" and len(sys.argv) >= 4:
        return cmd_migrate_wordstat(sys.argv[2], sys.argv[3:])
    if cmd == "stagecheck" and len(sys.argv) >= 3:
        return cmd_stagecheck(sys.argv[2])
    if cmd == "build" and len(sys.argv) >= 5:
        used = sys.argv[5] if len(sys.argv) >= 6 else None
        return cmd_build(sys.argv[2], sys.argv[3], sys.argv[4], used)
    print("неверные аргументы\n" + __doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
