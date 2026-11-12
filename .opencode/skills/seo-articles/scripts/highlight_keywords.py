#!/usr/bin/env python3
"""Оборачивает точные вхождения ключевых фраз в HTML в <mark>…</mark>.

Нужно, чтобы затем html_to_docx.py выделил их жёлтым в DOCX.

Использование:
    python3 highlight_keywords.py input.html output.html keywords.txt
    python3 highlight_keywords.py input.html output.html keywords.json

keywords.txt — по одной фразе на строку.
keywords.json — массив строк.
Совпадение регистронезависимое, исходный регистр текста сохраняется.
Обрабатываются только текстовые узлы (теги/атрибуты не затрагиваются).
"""
import sys
import os
import re
import json


def load_keywords(src: str) -> list[str]:
    ext = os.path.splitext(src)[1].lower()
    if ext == ".json":
        data = json.load(open(src, encoding="utf-8"))
        return [str(x).strip() for x in data if str(x).strip()]
    with open(src, encoding="utf-8") as f:
        raw = f.read()
    if "," in raw and "\n" not in raw.strip():
        return [p.strip() for p in raw.split(",") if p.strip()]
    return [p.strip() for p in raw.splitlines() if p.strip()]


def highlight(html_text: str, keywords: list[str]) -> tuple[str, int]:
    # Longest first so longer phrases win over their substrings.
    kws = sorted({k for k in keywords if k}, key=len, reverse=True)
    if not kws:
        return html_text, 0
    combined = re.compile("|".join(re.escape(k) for k in kws), re.IGNORECASE)

    count = 0

    def wrap_text(text: str) -> str:
        nonlocal count

        def repl(m: re.Match) -> str:
            nonlocal count
            count += 1
            return "<mark>" + m.group(0) + "</mark>"

        return combined.sub(repl, text)

    # Split on tags; transform only the text between them.
    parts = re.split(r"(<[^>]+>)", html_text)
    out = []
    for part in parts:
        if part.startswith("<") and part.endswith(">"):
            out.append(part)
        else:
            out.append(wrap_text(part))
    return "".join(out), count


def main() -> int:
    if len(sys.argv) < 4:
        print(
            "usage: highlight_keywords.py input.html output.html keywords(.txt|.json)",
            file=sys.stderr,
        )
        return 2
    src, dst, kw_src = sys.argv[1], sys.argv[2], sys.argv[3]
    kws = load_keywords(kw_src)
    html_text = open(src, encoding="utf-8").read()
    result, count = highlight(html_text, kws)
    with open(dst, "w", encoding="utf-8") as f:
        f.write(result)
    print(f"{dst} — подсвечено вхождений: {count}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
