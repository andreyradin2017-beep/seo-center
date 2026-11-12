#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Пункт 2.2 «Оформление текста» (технический SEO-аудит, методология «Текарт»).

Обходит все страницы сайта (sitemap.xml + перелинковка/навигация), выгружает заголовки H1–H6,
проверяет структуру заголовков (наличие и единственность H1, вложенность без пропусков уровней,
дубли, пустые и слишком длинные заголовки) и формирует:
  - листы «Текущие H1-H6» и (при системной проблеме) «Скорректированные H1-H6»
    в общем файле «Контент_<хост>.xlsx»;
  - «Оформление текста.docx» — подводка, проблемы, рекомендации.

Запуск:
  python3 heading_audit.py --url https://www.roysol.ru/ --out-dir /путь/куда/сохранить
"""
import argparse
import os
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urldefrag, urlparse, urlunparse

try:
    import requests
except ImportError:
    sys.exit("Нужен requests: pip3 install --break-system-packages requests")
try:
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit("Нужен beautifulsoup4: pip3 install --break-system-packages requests beautifulsoup4")
try:
    from openpyxl import Workbook, load_workbook
    from openpyxl.styles import Font, Alignment
except ImportError:
    sys.exit("Нужен openpyxl: pip3 install --break-system-packages openpyxl")
try:
    from docx import Document
    from docx.shared import Pt, RGBColor
    from docx.oxml.ns import qn
except ImportError:
    sys.exit("Нужен python-docx: pip3 install --break-system-packages python-docx")

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "tools" / "seo_collect"))
import http_cache

UA = {"User-Agent": "Mozilla/5.0 (compatible; SEO-audit/1.0)"}


def canon(u, host):
    p = urlparse(u)
    return urlunparse(("https", host, p.path or "/", "", p.query.strip("&"), ""))


def same_host(u, host):
    return urlparse(u).netloc in (host, host.replace("www.", ""), "www." + host.replace("www.", ""))


def skip_url(u):
    p = urlparse(u)
    path = p.path.lower()
    if path.startswith(("/tags/", "/jump", "/navi/", "/banners/", "/search")):
        return True
    if (path in ("", "/")) and p.query and "page=" not in p.query:
        return True
    return False


def get(url, timeout=25, cache_dir=None):
    return http_cache.get(url, headers=UA, timeout=timeout, allow_redirects=True, cache_dir=cache_dir)


def collect_pages(base, host, timeout=25, workers=10, cache_dir=None):
    """Параллельно обходит сайт (sitemap.xml + перелинковка). Возвращает {url: html}."""
    from concurrent.futures import ThreadPoolExecutor
    urls = set()
    for sm in ("/sitemap.xml", "/sitemap_index.xml", "/sitemap/"):
        try:
            r = get(urljoin(base, sm), timeout, cache_dir)
            if r.status_code != 200 or "<" not in r.text[:200]:
                continue
            import xml.etree.ElementTree as ET
            try:
                root = ET.fromstring(r.content)
            except Exception:
                continue
            for e in root.iter():
                if e.tag.endswith("loc") and e.text:
                    l = e.text.strip()
                    if not l.lower().startswith("http"):
                        l = urljoin(base, l)
                    if same_host(l, host):
                        c = canon(l, host)
                        if not skip_url(c):
                            urls.add(c)
            if urls:
                break
        except Exception:
            continue
    start = canon(base, host)
    urls.add(start)
    seen = set(urls)
    html_map = {}

    def fetch(u):
        try:
            r = get(u, timeout, cache_dir)
            if r.status_code == 200 and "html" in r.headers.get("Content-Type", ""):
                return u, r.text
        except Exception:
            pass
        return u, None

    with ThreadPoolExecutor(max_workers=workers) as ex:
        frontier = list(urls)
        while frontier:
            results = list(ex.map(fetch, frontier))
            frontier = []
            for u, html in results:
                if not html:
                    continue
                html_map[u] = html
                soup = BeautifulSoup(html, "html.parser")
                for a in soup.find_all("a", href=True):
                    h = a["href"].strip()
                    if h.startswith(("mailto:", "tel:", "javascript:", "#")):
                        continue
                    full = canon(urljoin(u, h), host)
                    if not full.startswith("http") or not same_host(full, host) or skip_url(full):
                        continue
                    if re.search(r"\.(pdf|jpe?g|png|gif|docx?|xlsx?|zip|rar|css|js|xml|txt|ico|svg|webp)$", full, re.I):
                        continue
                    if full not in seen:
                        seen.add(full)
                        frontier.append(full)
    return html_map


def classify(url, host):
    pu = urlparse(url)
    if (pu.path in ("", "/")) and not pu.query:
        return "Главная"
    if pu.path.endswith(("/index.htm", "/index.html")):
        return "Главная (тех. дубль)"
    if "/news" in pu.path:
        return "Новости"
    if "page=" in pu.query:
        p = re.search(r"page=([^&]+)", pu.query).group(1)
        if p == "metal-roll" or p.startswith("metalroll"):
            return "Металлопрокат"
        if p.startswith("salvage"):
            return "Металлолом"
        if p.startswith("gost"):
            return "ГОСТы / справка"
        if p.startswith("suppliers"):
            return "Поставщики"
        if p.startswith("consumers"):
            return "Потребители"
        if p.startswith("service"):
            return "Услуги"
        m = {"dele-m": "О компании", "representations": "Производственные площадки",
             "complex_service": "Комплексное обслуживание", "order": "Предварительный заказ",
             "job": "Вакансии", "contacts": "Контакты", "info": "Полезная информация",
             "map": "Карта сайта", "price": "Прайс", "links": "Ссылки"}
        if p in m:
            return m[p]
    return "Прочее"


def page_title(soup):
    if soup.title and soup.title.string:
        t = soup.title.string.strip()
        # убрать бренд через разделители
        for sep in ("|", "—", "–", "-", "::", "«"):
            if sep in t:
                t = t.split(sep)[0].strip()
                break
        return t
    return ""


def extract_headings(soup):
    for bad in soup(["script", "style", "noscript"]):
        bad.decompose()
    out = []
    for h in soup.find_all(re.compile(r"^h[1-6]$", re.I)):
        lvl = int(h.name[1])
        # пропускаем заголовки в футере/меню (не контентные)
        if h.find_parent(["nav", "footer"]) or h.find_parent(class_=re.compile(r"(footer|menu|nav)")):
            continue
        txt = h.get_text(" ", strip=True)
        out.append((lvl, txt))
    return out


def extract_h2_candidates(soup):
    """Абзацы-лид-ины (заканчиваются на «:») — кандидаты в подзаголовки H2."""
    el = None
    for sel in ("#content-column-left", "#content", "main", "article", ".content"):
        el = soup.select_one(sel)
        if el:
            break
    if not el:
        return []
    out = []
    for p in el.find_all("p"):
        t = p.get_text(" ", strip=True)
        if t.endswith(":") and 15 <= len(t) <= 90 and p.find_next_sibling(["ul", "ol", "table", "p", "div"]):
            cand = t[:-1].strip()
            if cand and cand not in out:
                out.append(cand)
    return out[:5]


def findings_and_fix(headings, title, section, h2_cand=None):
    """Возвращает (проблемы:list, corrected:list[(lvl,text)], changes:list)."""
    h2_cand = h2_cand or []
    hs = [(l, t) for (l, t) in headings if t.strip()]
    problems = []
    if not hs:
        problems.append("нет заголовков")
    h1s = [t for l, t in hs if l == 1]
    if not h1s:
        problems.append("отсутствует H1")
    elif len(h1s) > 1:
        problems.append(f"несколько H1 ({len(h1s)})")
    if hs and hs[0][0] != 1:
        problems.append(f"первый заголовок — H{hs[0][0]}, а не H1")
    # пропуски уровней
    prev = 0
    skips = 0
    for l, t in hs:
        if prev and l > prev + 1:
            skips += 1
        prev = l
    if skips:
        problems.append(f"пропуск уровней вложенности ({skips})")
    low = [t.lower() for l, t in hs]
    dups = sum(c - 1 for c in Counter(low).values() if c > 1)
    if dups:
        problems.append(f"повторяющиеся заголовки ({dups})")
    long_h = sum(1 for l, t in hs if len(t) > 80)
    if long_h:
        problems.append(f"слишком длинные заголовки ({long_h})")
    if hs and not any(l == 2 for l, t in hs) and len(hs) >= 2:
        problems.append("нет ни одного H2 (структура не выражена)")
    if hs and len(hs) == 1 and hs[0][0] == 1:
        problems.append("только H1, текст не структурирован")

    # ---- корректировка ----
    default_h1 = title or section or "Заголовок"
    corrected, changes = [], []
    used_h1 = False
    prev = 0
    for l, t in hs:
        if l == 1 and not used_h1:
            corrected.append((1, t)); used_h1 = True; prev = 1; continue
        target = 2 if l == 1 else l
        if prev == 0:
            target = 2
        if target > prev + 1:
            target = prev + 1
        target = max(2, min(target, 6))
        corrected.append((target, t))
        prev = target
    if not used_h1:
        corrected.insert(0, (1, default_h1))
        changes.append("добавлен H1")
    # дедуп подряд идущих дублей
    dedup, prev_txt = [], None
    for l, t in corrected:
        if t.lower() == (prev_txt or "").lower():
            changes.append("удалён повтор заголовка")
            continue
        dedup.append((l, t)); prev_txt = t
    corrected = dedup
    if len(h1s) > 1:
        changes.append("лишние H1 понижены")
    if skips:
        changes.append("выровнена вложенность (без пропуска уровней)")
    # добавить H2 на основе структуры текста, если их нет
    if not any(l == 2 for l, t in corrected) and h2_cand:
        idx = next((i for i, (l, t) in enumerate(corrected) if l == 1), -1)
        corrected = corrected[:idx + 1] + [(2, c) for c in h2_cand] + corrected[idx + 1:]
        changes.append("добавлены H2 из абзацев-подзаголовков")
    elif not any(l == 2 for l, t in corrected) and any(l == 1 for l, t in corrected):
        changes.append("требуется добавить H2 по смыслу текста (автоматически не определены)")
    return problems, corrected, changes


def set_font(run, size, color=None):
    run.font.size = Pt(size)
    if color is not None:
        run.font.color.rgb = color


def build_docx(path, base, rows, summary):
    doc = Document()
    doc.styles["Normal"].font.size = Pt(10)
    doc.styles["Normal"].font.name = "Calibri"
    doc.add_paragraph()
    t = doc.add_paragraph(); r = t.add_run(f"Технический аудит сайта {base}")
    set_font(r, 24, RGBColor(0x33, 0x33, 0x33))
    d = doc.add_paragraph(); rr = d.add_run(summary["month"])
    set_font(rr, 9, RGBColor(0x94, 0x29, 0x72))
    doc.add_paragraph()
    toc = doc.add_paragraph(); tr = toc.add_run("Содержание")
    set_font(tr, 20, RGBColor(0x33, 0x33, 0x33))
    doc.add_paragraph()
    doc.add_paragraph(); doc.add_paragraph()

    doc.add_heading("Анализ страничных факторов", level=1)
    doc.add_heading("2.2. Оформление текста", level=2)
    doc.add_paragraph(
        "Оформление текста — это структура страницы: заголовки H1–H6, абзацы, выделения и списки. "
        "Поисковым системам важна корректная иерархия заголовков: единственный H1, отражающий главную тему "
        "страницы, и вложенные H2–H3 без пропуска уровней. Заголовки помогают роботам понять смысл и "
        "структуру контента, участвуют в формировании релевантности и сниппетов, а также влияют на "
        "удобство чтения и поведенческие факторы. Заголовки, свёрстанные картинками или стилями, "
        "несколько H1, пропущенные уровни и «заголовки ради выделения» ухудшают восприятие структуры "
        "роботами и пользователями."
    )
    p = doc.add_paragraph(); p.add_run("В ходе проверки выявлены следующие проблемы:").bold = True
    for b in summary["problems"]:
        doc.add_paragraph(b, style="List Bullet")
    p = doc.add_paragraph(); r = p.add_run("Рекомендация: "); r.bold = True
    p.add_run("привести заголовки страниц к единой логичной иерархии:")
    for b in summary["recommendations"]:
        doc.add_paragraph(b, style="List Bullet")

    if summary["examples"]:
        doc.add_paragraph()
        cap = doc.add_paragraph(); cap.add_run("Таблица 1. Примеры страниц с проблемами заголовков").bold = True
        t = doc.add_table(rows=1, cols=4); t.style = "Table Grid"
        for i, h in enumerate(["Страница", "Текущие заголовки", "Проблема", "Скорректированный H1"]):
            c = t.rows[0].cells[i]; c.text = h
            for par in c.paragraphs:
                for run in par.runs:
                    run.bold = True
        for e in summary["examples"]:
            cells = t.add_row().cells
            cells[0].text = e["url"]; cells[1].text = e["current"]
            cells[2].text = e["problem"]; cells[3].text = e["fixed_h1"]
    doc.save(path)


def write_sheet(wb, name, headers, rows, widths):
    if name in wb.sheetnames:
        del wb[name]
    ws = wb.create_sheet(name, 0)
    ws.append(headers)
    for c in ws[1]:
        c.font = Font(bold=True); c.alignment = Alignment(vertical="top")
    for r in rows:
        ws.append(r)
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = w
    ws.freeze_panes = "A2"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--cache", default="", help="каталог HTTP-кэша (общий для всех пунктов аудита); пусто — без кэша")
    args = ap.parse_args()

    base = args.url if args.url.endswith("/") else args.url + "/"
    host = urlparse(base).netloc
    os.makedirs(args.out_dir, exist_ok=True)

    print(f"[1/3] Сбор URL: {base}")
    html_map = collect_pages(base, host, cache_dir=args.cache)
    print(f"      найдено URL: {len(html_map)}")

    rows = []
    for u, html in html_map.items():
        try:
            soup = BeautifulSoup(html, "html.parser")
            title = page_title(soup)
            section = classify(u, host)
            hs = extract_headings(soup)
            h2_cand = extract_h2_candidates(soup)
            problems, corrected, changes = findings_and_fix(hs, title, section, h2_cand)
            rows.append({"url": u, "section": section, "title": title,
                         "headings": hs, "problems": problems,
                         "corrected": corrected, "changes": changes,
                         "current_str": " | ".join(f"H{l}: {t}" for l, t in hs)})
        except Exception as e:
            print("   !", u, e)

    print(f"[2/3] Анализ заголовков: страниц {len(rows)}")
    total = len(rows)
    no_h1 = sum(1 for p in rows if "отсутствует H1" in p["problems"])
    multi_h1 = sum(1 for p in rows if any("несколько H1" in x for x in p["problems"]))
    skips = sum(1 for p in rows if any("пропуск уровней" in x for x in p["problems"]))
    first_not_h1 = sum(1 for p in rows if any("первый заголовок" in x for x in p["problems"]))
    no_h2 = sum(1 for p in rows if any("нет ни одного H2" in x for x in p["problems"]))
    need_fix = sum(1 for p in rows if p["problems"])
    only_h1 = sum(1 for p in rows if "только H1, текст не структурирован" in p["problems"])
    h_counts = Counter()
    for p in rows:
        for l, t in p["headings"]:
            h_counts[l] += 1

    problems = [
        f"H1: отсутствует на {no_h1} страницах; на {multi_h1} страницах несколько H1.",
        f"Вложенность: на {skips} страницах пропущены уровни (например, H1 → H3); "
        f"на {first_not_h1} страницах первый заголовок не H1.",
        f"Структура: на {no_h2} страницах нет ни одного H2; на {only_h1} страницах только H1 — "
        f"текст не разбит на смысловые блоки.",
        f"Всего требуется доработка заголовков на {need_fix} из {total} страниц.",
        f"Распределение заголовков по сайту: H1 — {h_counts[1]}, H2 — {h_counts[2]}, H3 — {h_counts[3]}, "
        f"H4 — {h_counts[4]}, H5 — {h_counts[5]}, H6 — {h_counts[6]}.",
    ]
    if total and need_fix == 0:
        problems = ["Проблем на сайте не обнаружено, исправления не требуются."]

    recommendations = [
        "На каждой странице — ровно один H1, отражающий главную тему и содержащий основной запрос.",
        "Выстроить иерархию H1 → H2 → H3 без пропуска уровней и без заголовков «ради выделения».",
        "Использовать заголовки по назначению (структура текста), а не для оформления шрифтом/цветом; "
        "заголовки-картинки заменить текстовыми.",
        "Включать ключевые запросы в H1 и H2–H3 (наиболее частотные — в H1, средне- и низкочастотные — в подзаголовки).",
        "Убрать повторы и слишком длинные заголовки; формулировать их кратко и по существу.",
        "Листы «Текущие H1-H6» и «Скорректированные H1-H6» в «Контент_<хост>.xlsx» — рабочие: "
        "по ним вносить правки в CMS и использовать как шаблон для новых страниц.",
    ]

    examples = []
    for p in sorted(rows, key=lambda x: -len(x["problems"]))[:12]:
        if not p["problems"]:
            continue
        fixed_h1 = next((t for l, t in p["corrected"] if l == 1), "")
        examples.append({"url": p["url"], "current": (p["current_str"] or "—")[:120],
                         "problem": "; ".join(p["problems"]), "fixed_h1": fixed_h1[:60]})

    # xlsx
    xlsx = os.path.join(args.out_dir, f"Контент_{host}.xlsx")
    wb = load_workbook(xlsx) if os.path.exists(xlsx) else Workbook()
    if not os.path.exists(xlsx):
        wb.remove(wb.active)
    cur_rows = []
    for i, p in enumerate(sorted(rows, key=lambda x: x["url"]), 1):
        by = {l: [] for l in range(1, 7)}
        for l, t in p["headings"]:
            by[l].append(t)
        cur_rows.append([i, p["url"], p["section"], p["title"],
                         " | ".join(by[1]) or "—", " | ".join(by[2]) or "—", " | ".join(by[3]) or "—",
                         " | ".join(by[4]) or "—", " | ".join(by[5]) or "—", " | ".join(by[6]) or "—",
                         len(p["headings"]), "; ".join(p["problems"]) or "—"])
    write_sheet(wb, "Текущие H1-H6",
                ["№", "URL", "Раздел", "Title", "H1", "H2", "H3", "H4", "H5", "H6", "Всего заголовков", "Проблемы"],
                cur_rows, [5, 44, 20, 34, 34, 34, 30, 24, 20, 20, 15, 46])

    systemic = total > 0 and need_fix >= max(1, int(total * 0.8))
    if systemic:
        fix_rows = []
        for i, p in enumerate(sorted(rows, key=lambda x: x["url"]), 1):
            by = {l: [] for l in range(1, 7)}
            for l, t in p["corrected"]:
                by[l].append(t)
            fix_rows.append([i, p["url"], p["section"],
                             " | ".join(by[1]) or "—", " | ".join(by[2]) or "—", " | ".join(by[3]) or "—",
                             " | ".join(by[4]) or "—", " | ".join(by[5]) or "—", " | ".join(by[6]) or "—",
                             "; ".join(dict.fromkeys(p["changes"])) or "без изменений"])
        write_sheet(wb, "Скорректированные H1-H6",
                    ["№", "URL", "Раздел", "H1", "H2", "H3", "H4", "H5", "H6", "Что изменено"],
                    fix_rows, [5, 44, 20, 34, 34, 30, 24, 20, 20, 40])
    wb.save(xlsx)

    summary = {"host": host, "month": datetime.now().strftime("%B %Y"), "problems": problems,
               "recommendations": recommendations, "examples": examples}
    month_ru = {"January": "Январь", "February": "Февраль", "March": "Март", "April": "Апрель",
                "May": "Май", "June": "Июнь", "July": "Июль", "August": "Август", "September": "Сентябрь",
                "October": "Октябрь", "November": "Ноябрь", "December": "Декабрь"}.get(
        datetime.now().strftime("%B"), datetime.now().strftime("%B"))
    summary["month"] = f"{month_ru} {datetime.now().year}"

    print("[3/3] Сохранение результатов")
    build_docx(os.path.join(args.out_dir, "Оформление текста.docx"), base, rows, summary)
    print("Готово:")
    print("  -", os.path.join(args.out_dir, "Оформление текста.docx"))
    print("  -", xlsx)
    print("  листы:", "Текущие H1-H6" + (", Скорректированные H1-H6" if systemic else " (системных правок не требуется)"))


if __name__ == "__main__":
    main()
