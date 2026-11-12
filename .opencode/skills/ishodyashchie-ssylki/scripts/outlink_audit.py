#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Пункт 2.5 «Исходящие ссылки» (технический SEO-аудит, методология «Текарт»).

Обходит все страницы сайта (sitemap.xml + перелинковка), собирает все внешние ссылки (<a href>),
классифицирует их (свои ресурсы / счётчики / виджеты и ссылочные «облака» / соцсети / прочие внешние),
проверяет rel (nofollow/sponsored/noopener) и формирует вывод: какие ссылки нужно закрывать от индексации.
Сохраняет листы «Исходящие ссылки» и «Рекомендации по ссылкам» в «Контент_<хост>.xlsx»
и отчёт «Исходящие ссылки.docx».

Запуск:
  python3 outlink_audit.py --url https://www.roysol.ru/ --out-dir /путь/куда/сохранить
"""
import argparse
import os
import re
import sys
from collections import defaultdict, Counter
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlparse, urlunparse

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
except ImportError:
    sys.exit("Нужен python-docx: pip3 install --break-system-packages python-docx")

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "tools" / "seo_collect"))
import http_cache

UA = {"User-Agent": "Mozilla/5.0 (compatible; SEO-audit/1.0)"}
COUNTERS = ("mail.ru", "rambler.ru", "hotlog.ru", "liveinternet.ru", "openstat", "yandex.ru",
               "google-analytics.com", "googletagmanager.com", "top100", "counter", "spylog", "24log")
WIDGETS = ("101widgets.com", "widget", "informer", "banner", "top100", "li.ru", "livejournal")
SOCIAL = ("vk.com", "t.me", "telegram", "ok.ru", "facebook.com", "instagram.com", "youtube.com",
          "twitter.com", "x.com", "whatsapp", "dzen.ru", "zen.yandex")


def registrable(host):
    host = host.replace("www.", "")
    parts = host.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def canon(u, host):
    p = urlparse(u)
    return urlunparse(("https", host, p.path or "/", "", p.query.strip("&"), ""))


def same_host(u, host):
    return registrable(urlparse(u).netloc) == registrable(host)


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


def classify_domain(dom, site_reg):
    d = dom.lower()
    reg = registrable(d)
    if reg == site_reg:
        return "Свой ресурс"
    if any(c in d for c in COUNTERS):
        return "Счётчик/аналитика"
    if any(w in d for w in WIDGETS):
        return "Виджет/ссылки"
    if any(s in d for s in SOCIAL):
        return "Соцсети"
    return "Внешний (прочий)"


def set_font(run, size, color=None):
    run.font.size = Pt(size)
    if color is not None:
        run.font.color.rgb = color


def build_docx(path, base, summary):
    doc = Document()
    doc.styles["Normal"].font.size = Pt(10)
    doc.styles["Normal"].font.name = "Calibri"
    doc.add_paragraph()
    t = doc.add_paragraph(); r = t.add_run(f"Технический аудит сайта {base}")
    set_font(r, 24, RGBColor(0x33, 0x33, 0x33))
    d = doc.add_paragraph(); rr = d.add_run(summary["month"]); set_font(rr, 9, RGBColor(0x94, 0x29, 0x72))
    doc.add_paragraph()
    toc = doc.add_paragraph(); tr = toc.add_run("Содержание"); set_font(tr, 20, RGBColor(0x33, 0x33, 0x33))
    doc.add_paragraph()
    doc.add_paragraph(); doc.add_paragraph()

    doc.add_heading("Анализ страничных факторов", level=1)
    doc.add_heading("2.5. Исходящие ссылки", level=2)
    doc.add_paragraph(
        "Исходящие ссылки — это ссылки с сайта на другие ресурсы. Поисковые системы учитывают их: "
        "ссылки на нерелевантные, сомнительные или «ссылочные» ресурсы размывают ссылочный вес сайта и "
        "могут восприниматься как злоупотребление, а сквозные ссылки в шаблоне (футер, виджеты) "
        "тиражируются на всех страницах и усиливают эффект. Чтобы сохранить вес и не передавать его "
        "чужим сайтам, часть внешних ссылок закрывают атрибутом rel=\"nofollow\" (или rel=\"sponsored\" "
        "для рекламных). При этом ссылки на собственные ресурсы (поддомены, проекты компании) закрывать "
        "не нужно — они передают вес внутри экосистемы. Важны также полезные внешние ссылки: они могут "
        "работать на доверие и поведенческие факторы, поэтому закрывать нужно не все, а ненужные."
    )
    p = doc.add_paragraph(); p.add_run("В ходе проверки выявлены следующие проблемы:").bold = True
    for b in summary["problems"]:
        doc.add_paragraph(b, style="List Bullet")
    p = doc.add_paragraph(); r = p.add_run("Рекомендация: "); r.bold = True
    p.add_run("привести исходящие ссылки в порядок:")
    for b in summary["recommendations"]:
        doc.add_paragraph(b, style="List Bullet")
    if summary["examples"]:
        doc.add_paragraph()
        cap = doc.add_paragraph(); cap.add_run("Таблица 1. Внешние ссылки по доменам и решение").bold = True
        t = doc.add_table(rows=1, cols=5); t.style = "Table Grid"
        for i, h in enumerate(["Домен", "Тип", "Ссылок", "Индексация", "Рекомендация"]):
            c = t.rows[0].cells[i]; c.text = h
            for par in c.paragraphs:
                for run in par.runs:
                    run.bold = True
        for e in summary["examples"]:
            cells = t.add_row().cells
            cells[0].text = e["domain"]; cells[1].text = e["type"]; cells[2].text = str(e["count"])
            cells[3].text = e["index"]; cells[4].text = e["rec"]
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
    site_reg = registrable(host)
    os.makedirs(args.out_dir, exist_ok=True)

    print(f"[1/3] Сбор URL: {base}")
    html_map = collect_pages(base, host, cache_dir=args.cache)
    print(f"      найдено URL: {len(html_map)}")

    # (page, domain) -> aggregate
    agg = {}
    domain_total = defaultdict(lambda: {"count": 0, "pages": set(), "nofollow": 0, "sponsored": 0,
                                        "blank_noopener": 0, "anchors": Counter(), "type": "", "dofollow": 0})
    pages_with_ext = set()
    for u, html in html_map.items():
        try:
            soup = BeautifulSoup(html, "html.parser")
            site = canon(u, host)
            for a in soup.find_all("a", href=True):
                h = a["href"].strip()
                if h.startswith(("mailto:", "tel:", "javascript:", "#")):
                    continue
                full = urljoin(u, h)
                if not full.lower().startswith("http"):
                    continue
                dom = urlparse(full).netloc.lower()
                if not dom or dom == urlparse(u).netloc.lower():
                    continue  # ссылки на ту же страницу/хост — не исходящие
                # свои поддомены (contacts.roysol.ru) считаем «свой ресурс», но это всё равно исходящие
                rel = a.get("rel") or []
                rel = [str(x).lower() for x in rel]
                nofollow = "nofollow" in rel
                sponsored = "sponsored" in rel
                noopener = "noopener" in rel or "noreferrer" in rel
                target = a.get("target") or ""
                anchor = a.get_text(" ", strip=True)
                dtype = classify_domain(dom, site_reg)
                key = (site, dom)
                rec = agg.setdefault(key, {"page": site, "domain": dom, "type": dtype, "count": 0,
                                           "nofollow": 0, "blank_noopener": 0, "anchors": Counter()})
                rec["count"] += 1
                if nofollow:
                    rec["nofollow"] += 1
                if target == "_blank" and not noopener:
                    rec["blank_noopener"] += 1
                if anchor:
                    rec["anchors"][anchor] += 1
                dt = domain_total[dom]
                dt["count"] += 1
                dt["pages"].add(site)
                dt["type"] = dtype
                dt["nofollow"] += 1 if nofollow else 0
                dt["sponsored"] += 1 if sponsored else 0
                dt["dofollow"] += 0 if nofollow else 1
                if target == "_blank" and not noopener:
                    dt["blank_noopener"] += 1
                pages_with_ext.add(site)
        except Exception as e:
            print("   !", u, e)

    # свои поддомены: добавим явно, если есть (contacts.roysol.ru и т.п.)
    total_links = sum(d["count"] for d in domain_total.values())
    total_domains = len(domain_total)
    dofollow_links = sum(d["dofollow"] for d in domain_total.values())
    nofollow_links = sum(d["nofollow"] for d in domain_total.values())
    third_party = {d: v for d, v in domain_total.items() if v["type"] not in ("Свой ресурс",)}
    third_dofollow = sum(v["dofollow"] for d, v in third_party.items())
    farms = {d: v for d, v in domain_total.items() if v["type"] == "Виджет/ссылки"}
    counters = {d: v for d, v in domain_total.items() if v["type"] == "Счётчик/аналитика"}
    own = {d: v for d, v in domain_total.items() if v["type"] == "Свой ресурс"}
    blank_noopener = sum(v["blank_noopener"] for v in domain_total.values())
    farm_links = sum(v["count"] for v in farms.values())

    problems = [
        f"Всего исходящих ссылок: {total_links} на {total_domains} домен(ов); страниц с внешними ссылками — {len(pages_with_ext)}.",
        f"Индексация: {dofollow_links} ссылок — dofollow (передают вес наружу), {nofollow_links} — с nofollow; "
        f"из них на сторонние ресурсы без nofollow — {third_dofollow}."
        if total_links else "Исходящих ссылок не обнаружено.",
    ]
    if farms:
        problems.append(f"Ссылочные «облака»/виджеты: {len(farms)} домен(ов), {farm_links} ссылок "
                        f"({', '.join(list(farms)[:3])}…) — сквозные, размещены в футере на всех страницах.")
    if counters:
        problems.append(f"Счётчики/аналитика (ссылки): {', '.join(list(counters)[:5])}.")
    if own:
        problems.append(f"Ссылки на свои ресурсы: {', '.join(list(own)[:5])} — закрывать от индексации не нужно.")
    if blank_noopener:
        problems.append(f"target=\"_blank\" без rel=\"noopener\": {blank_noopener} ссылок.")
    if not farms and not counters and not own:
        problems.append("Существенных проблем со сквозными ссылками не выявлено.")
    if total_links == 0 or (not farms and not blank_noopener and third_dofollow == 0):
        problems = ["Проблем на сайте не обнаружено, исправления не требуются."]

    recommendations = [
        "Ссылки на собственные ресурсы (поддомены, проекты компании) — оставить без изменений, "
        "они передают вес внутри вашей экосистемы.",
        "Ссылки на сторонние ресурсы, которые не нужны для пользователя, — закрыть rel=\"nofollow\", "
        "чтобы не отдавать ссылочный вес. Для рекламных/партнёрских — rel=\"sponsored\".",
        "Ссылочные «облака» и виджет-ссылки из футера — убрать или закрыть nofollow; сквозные ссылки "
        "тиражируются на всех страницах и сильнее всего размывают вес.",
        "Счётчики и аналитику оставить (они не несут SEO-ценности), но ссылковую часть закрыть nofollow.",
        "Полезные тематические внешние ссылки (партнёры, официальные ресурсы, источники) можно оставлять "
        "dofollow — они работают на доверие; достаточно убрать нерелевантные и сомнительные.",
        "Для всех ссылок с target=\"_blank\" добавить rel=\"noopener\" (безопасность и производительность).",
        "Листы «Исходящие ссылки» и «Рекомендации по ссылкам» в «Контент_<хост>.xlsx» — рабочие.",
    ]

    # examples: top domains by count
    def decide(dtype):
        if dtype == "Свой ресурс":
            return "Не закрывать", "свои ресурсы — вес остаётся внутри экосистемы"
        if dtype == "Виджет/ссылки":
            return "Убрать / nofollow", "сквозное ссылочное «облако» — убрать из футера или закрыть nofollow"
        if dtype == "Счётчик/аналитика":
            return "nofollow", "ссылки счётчиков закрыть nofollow"
        if dtype == "Соцсети":
            return "Оставить", "ссылки на соцсети компании уместны; при желании nofollow"
        return "nofollow (точечно)", "нерелевантные/ненужные закрыть nofollow; полезные можно оставить"

    examples = []
    for d, v in sorted(domain_total.items(), key=lambda kv: -kv[1]["count"])[:15]:
        decision, rec = decide(v["type"])
        examples.append({"domain": d, "type": v["type"], "count": v["count"], "index": decision, "rec": rec})

    # xlsx
    xlsx = os.path.join(args.out_dir, f"Контент_{host}.xlsx")
    wb = load_workbook(xlsx) if os.path.exists(xlsx) else Workbook()
    if not os.path.exists(xlsx):
        wb.remove(wb.active)
    rows = []
    for i, (key, v) in enumerate(sorted(agg.items(), key=lambda kv: (kv[0][0], kv[0][1])), 1):
        decisions = {"Свой ресурс": "Не закрывать", "Счётчик/аналитика": "nofollow",
                     "Виджет/ссылки": "Убрать / nofollow", "Соцсети": "Оставить"}
        rec_tail = ("свои ресурсы — оставить" if v["type"] == "Свой ресурс" else
                    "убрать сквозные ссылки/облако из футера" if v["type"] == "Виджет/ссылки" else
                    "закрыть nofollow" if v["type"] == "Счётчик/аналитика" else
                    "уместны; при желании nofollow" if v["type"] == "Соцсети" else
                    "закрыть nofollow, если ссылка не нужна пользователю")
        rows.append([i, v["page"], v["domain"], v["type"], v["count"],
                     ("nofollow" if v["nofollow"] == v["count"] else ("частично" if v["nofollow"] else "нет")),
                     v["blank_noopener"], " | ".join(a for a, _ in v["anchors"].most_common(2)),
                     decisions.get(v["type"], "nofollow (точечно)"), rec_tail])
    write_sheet(wb, "Исходящие ссылки",
                ["№", "Страница", "Домен", "Тип", "Ссылок", "rel", "target=_blank без noopener",
                 "Пример анкора", "Индексация", "Рекомендация"],
                rows, [5, 44, 26, 18, 8, 10, 20, 34, 16, 40])

    dom_rows = []
    for i, (d, v) in enumerate(sorted(domain_total.items(), key=lambda kv: -kv[1]["count"]), 1):
        decision, rec = decide(v["type"])
        dom_rows.append([i, d, v["type"], v["count"], len(v["pages"]), v["nofollow"], v["dofollow"],
                         v["blank_noopener"], decision, rec])
    write_sheet(wb, "Рекомендации по ссылкам",
                ["№", "Домен", "Тип", "Ссылок", "Страниц", "nofollow", "dofollow",
                 "blank без noopener", "Индексация", "Рекомендация"],
                dom_rows, [5, 30, 18, 8, 9, 10, 10, 18, 18, 46])
    wb.save(xlsx)

    month_ru = {"January": "Январь", "February": "Февраль", "March": "Март", "April": "Апрель",
                "May": "Май", "June": "Июнь", "July": "Июль", "August": "Август", "September": "Сентябрь",
                "October": "Октябрь", "November": "Ноябрь", "December": "Декабрь"}.get(
        datetime.now().strftime("%B"), datetime.now().strftime("%B"))
    summary = {"host": host, "month": f"{month_ru} {datetime.now().year}",
               "problems": problems, "recommendations": recommendations, "examples": examples}
    print("[3/3] Сохранение результатов")
    build_docx(os.path.join(args.out_dir, "Исходящие ссылки.docx"), base, summary)
    print("Готово:")
    print("  -", os.path.join(args.out_dir, "Исходящие ссылки.docx"))
    print("  -", xlsx)
    print("  листы: Исходящие ссылки, Рекомендации по ссылкам")


if __name__ == "__main__":
    main()
