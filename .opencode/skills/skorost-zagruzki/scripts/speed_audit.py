#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Пункт 4.1 «Скорость загрузки страниц» (технический SEO-аудит, методология «Текарт»).

Прогоняет все страницы сайта через Google PageSpeed и формирует:
  - «Скорость_<хост>.xlsx» — листы «Десктоп» и «Мобильные» (url, Оценка, LCP, TBT, FCP, SI, TTI, CLS);
  - «Скорость загрузки страниц.docx» — подводка, средние оценки и проблемы простым языком, рекомендации.

Прогон идёт через сервис coolakov.ru/tools/pagespeed (батч, параллельно), т.к. прямой
PageSpeed Insights API без ключа часто упирается в дневную квоту. Есть фолбэк на API.

Запуск:
  python3 speed_audit.py --url https://www.roysol.ru/ --out-dir /путь [--limit N] [--chunk 20]
"""
import argparse
import os
import re
import sys
import time
from datetime import datetime
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
    from openpyxl import Workbook
    from openpyxl.styles import Font, Alignment, PatternFill
except ImportError:
    sys.exit("Нужен openpyxl: pip3 install --break-system-packages openpyxl")
try:
    from docx import Document
    from docx.shared import Pt, RGBColor
except ImportError:
    sys.exit("Нужен python-docx: pip3 install --break-system-packages python-docx")

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"}
COOLAKOV = "https://coolakov.ru/tools/pagespeed/multi.php"
PSI = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"


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


def get(url, timeout=25):
    return requests.get(url, headers=UA, timeout=timeout, allow_redirects=True)


def importance_rank(u, host):
    """Приоритет страницы для выборочной проверки (меньше — важнее).

    Универсальная эвристика: главная → контакты/«о компании» → каталоги,
    разделы и разводящие страницы → карточки/услуги; новости, блог и статьи
    уходят в конец. Сохранены бонусы спец-страниц старых проектов.
    """
    p = urlparse(u)
    path = p.path.lower().strip("/")
    q = p.query.lower()
    seg = [s for s in path.split("/") if s]
    # Спец-лендинги (например, металлопрокат) — высокий приоритет.
    if any(k in q for k in ("page=metal-roll", "page=salvage", "page=service", "page=suppliers",
                            "page=consumers", "page=complex_service")):
        return 1
    if "page=gost" in q:
        return 3
    # Главная.
    if not seg and not q:
        return 0
    # Контакты / о компании / о нас.
    if any(k in path for k in ("contact", "kontakt", "about", "o-kompanii", "o-nas",
                               "company", "kompaniya")):
        return 1
    # Каталоги, разделы, разводящие.
    if any(k in path for k in ("catalog", "katalog", "category", "categor", "services",
                               "uslugi", "razdel", "section", "napravleniya")):
        return 2
    # Разводящая верхнего уровня (один сегмент пути).
    if len(seg) == 1:
        return 3
    # Карточки товаров/услуг.
    if any(k in path for k in ("product", "tovar", "goods", "item", "card", "service",
                               "usluga", "price", "cena")):
        return 4
    # Новости / блог / статьи — в конец.
    if any(k in path for k in ("news", "blog", "article", "novosti", "press",
                               "publication", "insights", "post")):
        return 7
    # Параметрические (пагинация, фильтры) — ниже содержательных.
    if q:
        return 6
    return 5


def sample_urls(urls, limit, host):
    return sorted(urls, key=lambda u: (importance_rank(u, host), u))[:limit]


def collect_urls(base, host, limit=50):
    urls = set()
    for sm in ("/sitemap.xml", "/sitemap_index.xml"):
        try:
            r = get(urljoin(base, sm))
            if r.status_code == 200 and "<" in r.text[:200]:
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
    # ограничиваем обход, если уже набрали достаточно из sitemap
    if limit and len(urls) >= limit:
        return sample_urls(urls, limit, host)
    queue, seen = list(urls), set(urls)
    while queue:
        u = queue.pop(0)
        try:
            r = get(u)
            if r.status_code != 200 or "html" not in r.headers.get("Content-Type", ""):
                continue
            soup = BeautifulSoup(r.text, "html.parser")
            for a in soup.find_all("a", href=True):
                h = a["href"].strip()
                if h.startswith(("mailto:", "tel:", "javascript:", "#")):
                    continue
                full = canon(urljoin(u, h), host)
                if re.search(r"\.(pdf|jpe?g|png|gif|css|js|zip|xml|txt|ico|svg)$", full, re.I):
                    continue
                if full.startswith("http") and same_host(full, host) and not skip_url(full) and full not in seen:
                    seen.add(full)
                    queue.append(full)
                    urls.add(full)
            if limit and len(urls) >= limit:
                break
        except Exception:
            continue
    res = sorted(urls)
    return sample_urls(res, limit, host) if limit else res


def parse_num(txt):
    if txt is None:
        return None
    t = str(txt).strip()
    m = re.match(r"^-?\d+(?:[.,]\d+)?", t)
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", "."))
    except Exception:
        return None


def parse_tables(html):
    """Парсит обе таблицы coolakov → {'desktop': [...], 'mobile': [...]}."""
    s = BeautifulSoup(html, "html.parser")
    out = {"desktop": [], "mobile": []}
    for tid, key in (("list-pages", "desktop"), ("list-domens", "mobile")):
        tab = s.find(id=tid)
        if not tab:
            continue
        tbl = tab.find("table")
        if not tbl:
            continue
        body = tbl.find("tbody")
        rows = body.find_all("tr") if body else tbl.find_all("tr")[1:]
        for tr in rows:
            tds = [td.get_text(" ", strip=True) for td in tr.find_all("td")]
            if len(tds) < 9:
                continue
            url = re.sub(r"\s+(orig|i)$", "", tds[1]).strip()
            rec = {"url": url, "score": parse_num(tds[2]), "lcp": parse_num(tds[3]),
                   "tbt": parse_num(tds[4]), "fcp": parse_num(tds[5]), "si": parse_num(tds[6]),
                   "tti": parse_num(tds[7]), "cls": parse_num(tds[8])}
            if rec["url"]:
                out[key].append(rec)
    return out


def run_coolakov(urls, chunk=20):
    results = {"desktop": [], "mobile": []}
    for i in range(0, len(urls), chunk):
        part = urls[i:i + chunk]
        print(f"      батч {i // chunk + 1}: {len(part)} URL…")
        try:
            r = requests.post(COOLAKOV, data={"myurl": "multi.php", "idquery": str(int(time.time() * 1000)),
                                              "urls": "\n".join(part)},
                              headers={**UA, "X-Requested-With": "XMLHttpRequest",
                                       "Referer": "https://coolakov.ru/tools/pagespeed/"},
                              timeout=540)
            if r.status_code != 200:
                print("      сервис вернул", r.status_code)
                continue
            parsed = parse_tables(r.text)
            results["desktop"].extend(parsed["desktop"])
            results["mobile"].extend(parsed["mobile"])
        except Exception as e:
            print("      ошибка батча:", e)
    return results


def run_psi(url, strategy):
    try:
        r = requests.get(PSI, params={"url": url, "strategy": strategy, "category": "performance"}, timeout=90)
        if r.status_code != 200:
            return None
        a = r.json().get("lighthouseResult", {})
        au = a.get("audits", {})
        def sec(k):
            v = au.get(k, {}).get("numericValue")
            return round(v / 1000, 1) if isinstance(v, (int, float)) else None
        return {"url": url, "score": round((a.get("categories", {}).get("performance", {}).get("score") or 0) * 100),
                "lcp": sec("largest-contentful-paint"), "tbt": sec("total-blocking-time"),
                "fcp": sec("first-contentful-paint"), "si": sec("speed-index"), "tti": sec("interactive"),
                "cls": au.get("cumulative-layout-shift", {}).get("numericValue")}
    except Exception:
        return None


def avg(rows, key):
    vals = [r[key] for r in rows if r.get(key) is not None]
    return round(sum(vals) / len(vals), 1) if vals else None


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

    doc.add_heading("Анализ технических факторов со стороны сервера", level=1)
    doc.add_heading("4.1. Скорость загрузки страниц", level=2)
    doc.add_paragraph(
        "Скорость загрузки страниц напрямую влияет на поведение пользователей и позиции сайта. Чем дольше "
        "страница открывается, тем чаще люди уходят, не дождавшись её (это называют «показателями Core Web "
        "Vitals»). Поисковые системы учитывают эти показатели при ранжировании, особенно на мобильных "
        "устройствах, где скорость загрузки в среднем ниже. Быстрый сайт улучшает конверсию, снижает отказы "
        "и помогает лучше индексироваться. Ниже — результаты проверки всех страниц сайта через Google PageSpeed."
    )
    doc.add_paragraph("Средние оценки по сайту:")
    doc.add_paragraph(f"Десктоп: {summary['avg_desktop']} из 100.", style="List Bullet")
    doc.add_paragraph(f"Мобильные: {summary['avg_mobile']} из 100.", style="List Bullet")
    p = doc.add_paragraph(); p.add_run("В ходе проверки выявлены следующие проблемы:").bold = True
    for b in summary["problems"]:
        doc.add_paragraph(b, style="List Bullet")
    p = doc.add_paragraph(); r = p.add_run("Рекомендация: "); r.bold = True
    p.add_run("что улучшить, чтобы страницы грузились быстрее:")
    for b in summary["recommendations"]:
        doc.add_paragraph(b, style="List Bullet")
    if summary["worst"]:
        doc.add_paragraph()
        cap = doc.add_paragraph(); cap.add_run("Таблица 1. Страницы с самой низкой оценкой").bold = True
        t = doc.add_table(rows=1, cols=5); t.style = "Table Grid"
        for i, h in enumerate(["Страница", "Оценка (mobile)", "Оценка (desktop)", "LCP, с", "CLS"]):
            c = t.rows[0].cells[i]; c.text = h
            for par in c.paragraphs:
                for run in par.runs:
                    run.bold = True
        for e in summary["worst"]:
            cells = t.add_row().cells
            cells[0].text = e["url"]; cells[1].text = str(e["m"]); cells[2].text = str(e["d"])
            cells[3].text = str(e["lcp"]); cells[4].text = str(e["cls"])
    doc.add_paragraph()
    doc.add_paragraph("Сводная таблица с оценкой всех страниц: файл «Скорость_"
                      + summary["host"] + ".xlsx» (листы «Десктоп» и «Мобильные»).")
    doc.save(path)


def write_xlsx(path, results):
    wb = Workbook()
    wb.remove(wb.active)
    headers = ["url", "Оценка", "LCP", "TBT", "FCP", "SI", "TTI", "CLS"]
    for key, name in (("desktop", "Десктоп"), ("mobile", "Мобильные")):
        ws = wb.create_sheet(name)
        ws.append(headers)
        for c in ws[1]:
            c.font = Font(bold=True)
        for r in sorted(results[key], key=lambda x: x["url"]):
            ws.append([r["url"], r["score"], r["lcp"], r["tbt"], r["fcp"], r["si"], r["tti"], r["cls"]])
        for i, w in enumerate([50, 10, 8, 8, 8, 8, 8, 8], 1):
            ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = w
        ws.freeze_panes = "A2"
    wb.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--limit", type=int, default=50, help="проверять не более N наиболее важных страниц (0 = все)")
    ap.add_argument("--chunk", type=int, default=20)
    args = ap.parse_args()

    base = args.url if args.url.endswith("/") else args.url + "/"
    host = urlparse(base).netloc
    os.makedirs(args.out_dir, exist_ok=True)

    print("[1/3] Сбор URL")
    urls = collect_urls(base, host, args.limit)
    print(f"      страниц: {len(urls)}")

    print("[2/3] Прогон через Google PageSpeed (coolakov.ru)")
    results = run_coolakov(urls, args.chunk)
    if not results["desktop"] and not results["mobile"]:
        print("      сервис недоступен — пробую PageSpeed Insights API (может упереться в квоту)")
        results = {"desktop": [], "mobile": []}
        for u in urls:
            for strat, key in (("desktop", "desktop"), ("mobile", "mobile")):
                r = run_psi(u, strat)
                if r:
                    results[key].append(r)
    print(f"      получено: desktop {len(results['desktop'])}, mobile {len(results['mobile'])}")

    avg_d = avg(results["desktop"], "score")
    avg_m = avg(results["mobile"], "score")
    print(f"[3/3] Средние оценки — десктоп {avg_d}, мобильные {avg_m}")

    def zone(v):
        if v is None:
            return "нет данных"
        return "хорошо" if v >= 90 else ("требует улучшения" if v >= 50 else "плохо (красная зона)")

    d_map = {r["url"]: r for r in results["desktop"]}
    m_map = {r["url"]: r for r in results["mobile"]}
    all_urls = sorted(set(d_map) | set(m_map))
    red_m = sum(1 for u in all_urls if (m_map.get(u, {}).get("score") or 101) < 50)
    red_d = sum(1 for u in all_urls if (d_map.get(u, {}).get("score") or 101) < 50)
    slow_lcp = sum(1 for u in all_urls if (m_map.get(u, {}).get("lcp") or 0) > 4)
    mid_lcp = sum(1 for u in all_urls if 2.5 < (m_map.get(u, {}).get("lcp") or 0) <= 4)
    bad_cls = sum(1 for u in all_urls if (m_map.get(u, {}).get("cls") or 0) > 0.25)
    avg_lcp_m = avg(results["mobile"], "lcp")

    problems = [
        f"Средняя оценка мобильной версии — {avg_m} из 100 ({zone(avg_m)}), десктопной — {avg_d} из 100 ({zone(avg_d)}).",
        f"Мобильные страницы: {red_m} в «красной зоне» (оценка ниже 50), {red_d} таких же на десктопе."
        if (red_m or red_d) else "Критично низких оценок нет, но есть зоны роста.",
        f"Время появления основного контента (LCP) на мобильных в среднем {avg_lcp_m} с: "
        f"у {slow_lcp} страниц LCP больше 4 с (плохо), ещё у {mid_lcp} — 2,5–4 с (нужно улучшить). "
        f"Пользователь видит контент с заметной задержкой.",
        f"Сдвиг вёрстки (CLS) выше нормы на {bad_cls} мобильных страницах — элементы «прыгают» при загрузке."
        if bad_cls else "Сдвиг вёрстки (CLS) в пределах нормы.",
        "Основные причины медленной загрузки — тяжёлые изображения, избыточные скрипты и виджеты, "
        "отсутствие сжатия и кэширования (подробности — в сводной таблице).",
    ]
    if all_urls and (avg_m or 0) >= 90 and (avg_d or 0) >= 90 and slow_lcp == 0 and bad_cls == 0:
        problems = ["Проблем на сайте не обнаружено, исправления не требуются."]
    recommendations = [
        "Сжать и перевести изображения в современный формат (WebP/AVIF), подогнать их размер под блоки "
        "(не грузить большие картинки в маленькие блоки) — изображения чаще всего и тормозят загрузку.",
        "Указать размеры (width/height) для всех картинок и включить отложенную загрузку (lazy-load) — "
        "это убирает «прыжки» вёрстки.",
        "Отложить загрузку сторонних виджетов, счётчиков и баннеров (в т.ч. в подвале) — грузить их только "
        "после начала взаимодействия с сайтом (прокрутка/клик).",
        "Убрать неиспользуемый CSS и JS, объединить и минифицировать скрипты; подключать скрипты в конце "
        "страницы или с атрибутом defer/async.",
        "Включить сжатие (gzip/brotli) и кэширование статики на сервере, настроить HTTP-кэш для изображений, "
        "стилей и скриптов.",
        "Оптимизировать шрифты (подмножества, font-display: swap, локальные шрифты вместо внешних).",
        "Проверить скорость ответа сервера (TTFB) и при необходимости сменить/усилить хостинг, включить CDN.",
        "Регулярно контролировать Core Web Vitals в Google Search Console и Яндекс.Вебмастере.",
    ]
    worst = []
    for u in sorted(all_urls, key=lambda x: (m_map.get(x, {}).get("score") if m_map.get(x, {}).get("score") is not None else 101))[:12]:
        worst.append({"url": u, "m": m_map.get(u, {}).get("score"), "d": d_map.get(u, {}).get("score"),
                      "lcp": m_map.get(u, {}).get("lcp"), "cls": m_map.get(u, {}).get("cls")})

    xlsx = os.path.join(args.out_dir, f"Скорость_{host}.xlsx")
    write_xlsx(xlsx, results)
    month_ru = {"January": "Январь", "February": "Февраль", "March": "Март", "April": "Апрель",
                "May": "Май", "June": "Июнь", "July": "Июль", "August": "Август", "September": "Сентябрь",
                "October": "Октябрь", "November": "Ноябрь", "December": "Декабрь"}.get(
        datetime.now().strftime("%B"), datetime.now().strftime("%B"))
    summary = {"host": host, "month": f"{month_ru} {datetime.now().year}", "problems": problems,
               "recommendations": recommendations, "avg_desktop": avg_d, "avg_mobile": avg_m, "worst": worst}
    build_docx(os.path.join(args.out_dir, "Скорость загрузки страниц.docx"), base, summary)
    print("Готово:")
    print("  -", os.path.join(args.out_dir, "Скорость загрузки страниц.docx"))
    print("  -", xlsx)


if __name__ == "__main__":
    main()
