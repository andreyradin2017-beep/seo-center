#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Пункт 2.4 «Изображения» (технический SEO-аудит, методология «Текарт»).

Обходит все страницы сайта (sitemap.xml + перелинковка), собирает все изображения,
проверяет: вес, сжатие/формат, реальные и отображаемые размеры, атрибуты alt, title,
width/height, lazy-loading. Формирует:
  - листы «Изображения» и «Рекомендации по изображениям» в общем «Контент_<хост>.xlsx»;
  - «Изображения.docx» — подводка, проблемы, рекомендации (SEO + скорость загрузки).

Запуск:
  python3 image_audit.py --url https://www.roysol.ru/ --out-dir /путь/куда/сохранить
"""
import argparse
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime
from io import BytesIO
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
try:
    from PIL import Image
except ImportError:
    sys.exit("Нужен Pillow: pip3 install --break-system-packages pillow")

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "tools" / "seo_collect"))
import http_cache

UA = {"User-Agent": "Mozilla/5.0 (compatible; SEO-audit/1.0)"}
NEXTGEN = {"WEBP", "AVIF"}
HEAVY_KB, VERY_HEAVY_KB = 100, 200
BIG_SIDE = 2000


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
                    if re.search(r"\\.(pdf|jpe?g|png|gif|docx?|xlsx?|zip|rar|css|js|xml|txt|ico|svg|webp)$", full, re.I):
                        continue
                    if full not in seen:
                        seen.add(full)
                        frontier.append(full)
    return html_map



def parse_size(v):
    if not v:
        return None
    m = re.match(r"(\d+)", str(v))
    return int(m.group(1)) if m else None


def style_size(style):
    w = h = None
    if not style:
        return None, None
    mw = re.search(r"width\s*:\s*(\d+)px", style)
    mh = re.search(r"height\s*:\s*(\d+)px", style)
    if mw:
        w = int(mw.group(1))
    if mh:
        h = int(mh.group(1))
    return w, h


def img_meta(url, cache, timeout=25):
    if url in cache:
        return cache[url]
    info = {"size": None, "w": None, "h": None, "format": None, "status": None}
    try:
        r = requests.get(url, headers=UA, timeout=timeout, stream=True)
        info["status"] = r.status_code
        if r.status_code == 200:
            cl = r.headers.get("Content-Length")
            data = r.content
            info["size"] = len(data) if data else (int(cl) if cl else None)
            if info["size"] and info["size"] <= 4 * 1024 * 1024:
                try:
                    im = Image.open(BytesIO(data))
                    info["w"], info["h"] = im.size
                    info["format"] = (im.format or "").upper() or None
                except Exception:
                    ext = os.path.splitext(urlparse(url).path)[1].lstrip(".").upper()
                    info["format"] = ext or None
    except Exception:
        pass
    cache[url] = info
    return info


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
    doc.add_heading("2.4. Изображения", level=2)
    doc.add_paragraph(
        "Изображения участвуют в ранжировании (поиск по картинкам, релевантность страницы) и напрямую "
        "влияют на скорость загрузки и показатели Core Web Vitals (LCP, CLS). Для поисковых систем важны "
        "атрибуты alt и title, корректные размеры и осмысленные имена файлов; для скорости — оптимизированный "
        "формат (WebP/AVIF), сжатие, соответствие реального размера отображаемому и ленивая загрузка. "
        "Изображения с избыточным разрешением, лишним весом, отсутствующим alt или без размеров замедляют "
        "загрузку, создают сдвиг вёрстки и теряют трафик из поиска по картинкам."
    )
    p = doc.add_paragraph(); p.add_run("В ходе проверки выявлены следующие проблемы:").bold = True
    for b in summary["problems"]:
        doc.add_paragraph(b, style="List Bullet")
    p = doc.add_paragraph(); r = p.add_run("Рекомендация: "); r.bold = True
    p.add_run("доработать изображения по двум направлениям:")
    for b in summary["recommendations"]:
        doc.add_paragraph(b, style="List Bullet")
    if summary["examples"]:
        doc.add_paragraph()
        cap = doc.add_paragraph(); cap.add_run("Таблица 1. Примеры изображений, требующих доработки").bold = True
        t = doc.add_table(rows=1, cols=5); t.style = "Table Grid"
        for i, h in enumerate(["Файл", "Реальный размер", "Вес, КБ", "Формат", "Проблемы"]):
            c = t.rows[0].cells[i]; c.text = h
            for par in c.paragraphs:
                for run in par.runs:
                    run.bold = True
        for e in summary["examples"]:
            cells = t.add_row().cells
            cells[0].text = e["file"]; cells[1].text = e["dims"]; cells[2].text = e["kb"]
            cells[3].text = e["fmt"]; cells[4].text = e["problem"]
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

    cache = {}
    images = {}  # src -> aggregated
    for u, html in html_map.items():
        try:
            soup = BeautifulSoup(html, "html.parser")
            for im in soup.find_all("img"):
                src = (im.get("src") or "").strip()
                if not src or src.startswith("data:"):
                    continue
                full = urljoin(u, src)
                if not full.lower().startswith("http") or not same_host(full, host):
                    continue
                sw, sh = parse_size(im.get("width")), parse_size(im.get("height"))
                if sw is None or sh is None:
                    cw, ch = style_size(im.get("style"))
                    sw = sw or cw
                    sh = sh or ch
                rec = images.setdefault(full, {"src": full, "alt": None, "title": None, "pages": set(),
                                               "w": None, "h": None, "loading": False})
                alt = im.get("alt")
                if rec["alt"] is None and alt is not None:
                    rec["alt"] = alt
                if rec["title"] is None and im.get("title"):
                    rec["title"] = im.get("title")
                if sw and not rec["w"]:
                    rec["w"] = sw
                if sh and not rec["h"]:
                    rec["h"] = sh
                if im.get("loading") == "lazy":
                    rec["loading"] = True
                rec["pages"].add(canon(u, host))
        except Exception as e:
            print("   !", u, e)

    print(f"[2/3] Проверка изображений: уникальных {len(images)}")
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=12) as ex:
        metas = list(ex.map(lambda s: (s, img_meta(s, cache)), images.keys()))
    for src, m in metas:
        images[src].update({"size": m["size"], "nat_w": m["w"], "nat_h": m["h"], "format": m["format"], "status": m["status"]})

    problems = []
    for src, rec in images.items():
        probs = []
        alt = rec["alt"]
        if alt is None:
            probs.append("нет атрибута alt")
        elif str(alt).strip() == "":
            probs.append("пустой alt")
        elif len(str(alt)) > 125:
            probs.append("alt слишком длинный")
        if not rec["title"]:
            probs.append("нет title")
        if not rec["w"] or not rec["h"]:
            probs.append("нет width/height (риск CLS)")
        fmt = (rec["format"] or "").upper()
        if fmt and fmt not in NEXTGEN:
            probs.append(f"формат {fmt} — не WebP/AVIF")
        kb = round((rec["size"] or 0) / 1024, 1)
        if kb > VERY_HEAVY_KB:
            probs.append(f"очень тяжёлое ({kb} КБ)")
        elif kb > HEAVY_KB:
            probs.append(f"тяжёлое ({kb} КБ)")
        nw, nh = rec["nat_w"], rec["nat_h"]
        if nw and rec["w"] and rec["w"] > 0:
            if nw >= rec["w"] * 2:
                probs.append(f"избыточное разрешение: {nw}px при отображении {rec['w']}px")
            elif nw < rec["w"]:
                probs.append(f"низкое разрешение: {nw}px < отображения {rec['w']}px")
        if nw and nw > BIG_SIDE:
            probs.append(f"слишком большое по ширине ({nw}px)")
        if not rec["loading"]:
            probs.append("нет loading=lazy")
        rec["problems"] = probs

    total = len(images)
    no_alt = sum(1 for r in images.values() if r["alt"] is None or str(r["alt"]).strip() == "")
    no_title = sum(1 for r in images.values() if not r["title"])
    no_dims = sum(1 for r in images.values() if not r["w"] or not r["h"])
    bad_fmt = sum(1 for r in images.values() if (r["format"] or "").upper() not in NEXTGEN and r["format"])
    heavy = sum(1 for r in images.values() if (r["size"] or 0) > HEAVY_KB * 1024)
    no_lazy = sum(1 for r in images.values() if not r["loading"])
    overweight = sum(1 for r in images.values() if any("избыточное разрешение" in p for p in r["problems"]))
    under = sum(1 for r in images.values() if any("низкое разрешение" in p for p in r["problems"]))
    total_kb = round(sum((r["size"] or 0) for r in images.values()) / 1024, 1)
    need_fix = sum(1 for r in images.values() if r["problems"])

    problems = [
        f"Всего изображений: {total}; общий вес ~{total_kb} КБ.",
        f"Alt: отсутствует/пустой у {no_alt} изображений — теряется контекст для поиска по картинкам и доступности.",
        f"Title: не задан у {no_title} изображений (вспомогательный, но полезный атрибут).",
        f"Размеры: у {no_dims} изображений нет атрибутов width/height — риск сдвига вёрстки (CLS).",
        f"Формат: у {bad_fmt} изображений формат не оптимизирован (использовать WebP/AVIF).",
        f"Вес/сжатие: {heavy} изображений тяжелее {HEAVY_KB} КБ — замедляют загрузку.",
        f"Разрешение: {overweight} изображений с избыточным разрешением (реально больше отображаемого), "
        f"{under} — с недостаточным (растянуты/размыты).",
        f"Ленивая загрузка: у {no_lazy} изображений нет loading=lazy.",
        f"Требуется доработка у {need_fix} из {total} изображений.",
    ]
    if total and need_fix == 0:
        problems = ["Проблем на сайте не обнаружено, исправления не требуются."]
    recommendations = [
        "Для поисковых систем: заполнить осмысленный alt (кратко описывает содержимое, без переспама), "
        "задать title где уместно, использовать понятные имена файлов и релевантные изображения на странице.",
        "Для скорости загрузки: перевести изображения в WebP/AVIF, сжать до приемлемого веса "
        f"(ориентир ≤ {HEAVY_KB}–{VERY_HEAVY_KB} КБ для контентных изображений).",
        "Реальный размер изображения должен соответствовать отображаемому (не грузить 5000px в блок 200px "
        "и не растягивать маленькие картинки) — использовать srcset/picture для адаптивности.",
        "Задавать width/height (или aspect-ratio) для всех изображений — устраняет сдвиг вёрстки (CLS).",
        "Включить loading=lazy для изображений вне первого экрана, а для LCP-изображения — наоборот, "
        "приоритетную загрузку (fetchpriority=high, без lazy).",
        "Листы «Изображения» и «Рекомендации по изображениям» в «Контент_<хост>.xlsx» — рабочие: "
        "по ним вносить правки.",
    ]

    examples = []
    for r in sorted(images.values(), key=lambda x: -(x["size"] or 0))[:12]:
        if not r["problems"]:
            continue
        examples.append({"file": r["src"].split("/")[-1][:50],
                         "dims": (f"{r['nat_w']}×{r['nat_h']}" if r["nat_w"] else "—"),
                         "kb": str(round((r["size"] or 0) / 1024, 1)),
                         "fmt": r["format"] or "—", "problem": "; ".join(r["problems"])[:120]})

    # xlsx
    xlsx = os.path.join(args.out_dir, f"Контент_{host}.xlsx")
    wb = load_workbook(xlsx) if os.path.exists(xlsx) else Workbook()
    if not os.path.exists(xlsx):
        wb.remove(wb.active)
    rows = []
    for i, r in enumerate(sorted(images.values(), key=lambda x: -(x["size"] or 0)), 1):
        rows.append([i, r["src"], (r["alt"] if r["alt"] is not None else "—"), (r["title"] or "—"),
                     (r["w"] or "—"), (r["h"] or "—"),
                     (f"{r['nat_w']}×{r['nat_h']}" if r["nat_w"] else "—"),
                     r["format"] or "—", round((r["size"] or 0) / 1024, 1),
                     len(r["pages"]), ("да" if r["loading"] else "нет"),
                     "; ".join(r["problems"]) or "—"])
    write_sheet(wb, "Изображения",
                ["№", "Файл (src)", "Alt", "Title", "Width (attr)", "Height (attr)", "Реальный размер",
                 "Формат", "Вес, КБ", "Страниц", "Lazy", "Проблемы"],
                rows, [5, 50, 26, 20, 12, 12, 16, 10, 10, 9, 7, 50])

    systemic = total > 0 and need_fix >= max(1, int(total * 0.5))
    if systemic:
        fix_rows = []
        for i, r in enumerate(sorted(images.values(), key=lambda x: -(x["size"] or 0)), 1):
            actions = []
            if r["alt"] is None or str(r["alt"]).strip() == "":
                actions.append("заполнить alt по смыслу изображения")
            if not r["title"]:
                actions.append("добавить title (по желанию)")
            if not r["w"] or not r["h"]:
                dims = f"{r['nat_w']}×{r['nat_h']}" if r["nat_w"] else "по контейнеру"
                actions.append(f"задать width/height ({dims})")
            if (r["format"] or "").upper() not in NEXTGEN and r["format"]:
                actions.append("перевести в WebP/AVIF")
            if (r["size"] or 0) > HEAVY_KB * 1024:
                actions.append(f"сжать (≤{VERY_HEAVY_KB} КБ)")
            if r["nat_w"] and r["w"] and r["nat_w"] >= r["w"] * 2:
                actions.append(f"уменьшить до {r['w']}px")
            if r["nat_w"] and r["w"] and r["nat_w"] < r["w"]:
                actions.append("заменить на изображение большего разрешения")
            if not r["loading"]:
                actions.append("добавить loading=lazy")
            rec_alt = r["alt"] if (r["alt"] and str(r["alt"]).strip()) else "—"
            rec_dims = f"{r['nat_w']}×{r['nat_h']}" if r["nat_w"] else "—"
            fix_rows.append([i, r["src"], (" / ".join(dict.fromkeys(actions)) or "—"),
                             rec_alt, rec_dims, "WebP/AVIF", f"≤ {VERY_HEAVY_KB} КБ"])
        write_sheet(wb, "Рекомендации по изображениям",
                    ["№", "Файл (src)", "Что сделать", "Рекомендуемый alt", "Рекомендуемые размеры",
                     "Рекомендуемый формат", "Целевой вес"],
                    fix_rows, [5, 50, 60, 30, 20, 18, 14])
    wb.save(xlsx)

    month_ru = {"January": "Январь", "February": "Февраль", "March": "Март", "April": "Апрель",
                "May": "Май", "June": "Июнь", "July": "Июль", "August": "Август", "September": "Сентябрь",
                "October": "Октябрь", "November": "Ноябрь", "December": "Декабрь"}.get(
        datetime.now().strftime("%B"), datetime.now().strftime("%B"))
    summary = {"host": host, "month": f"{month_ru} {datetime.now().year}",
               "problems": problems, "recommendations": recommendations, "examples": examples}
    print("[3/3] Сохранение результатов")
    build_docx(os.path.join(args.out_dir, "Изображения.docx"), base, summary)
    print("Готово:")
    print("  -", os.path.join(args.out_dir, "Изображения.docx"))
    print("  -", xlsx)
    print("  листы:", "Изображения" + (", Рекомендации по изображениям" if systemic else ""))


if __name__ == "__main__":
    main()
