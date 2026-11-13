#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Пункт 2.3 «Служебные теги» (технический SEO-аудит, методология «Текарт»).

Обходит все страницы сайта (sitemap.xml + перелинковка), выгружает title и description,
находит проблемы (пустые/дубли/длина/шаблонность), формирует скорректированные метатеги:
  - по семантическому ядру (если передан файл --semcore), либо
  - по правилам (базово корректные title/description).
Сохраняет листы «Текущие метатеги» и «Скорректированные метатеги» в общий «Контент_<хост>.xlsx»
и отчёт «Служебные теги.docx».

Запуск:
  python3 meta_audit.py --url https://www.roysol.ru/ --out-dir /путь [--semcore файл.xlsx] [--brand Roysol]
"""
import argparse
import csv
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlparse, urlunparse, parse_qsl, urlencode

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
GENERIC_TITLES = {"компания", "главная", "сайт", "главная страница", "home", "index", "официальный сайт", ""}


def load_audit_rules():
    """Машиночитаемые правила аудита из .opencode/rules/audit-rules.json (единый источник)."""
    rules_path = Path(__file__).resolve().parents[3] / "rules" / "audit-rules.json"
    try:
        import json as _json
        return _json.loads(rules_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


_RULES = load_audit_rules()
_META = _RULES.get("meta", {})
_CANON = _RULES.get("canonical", {})
TITLE_MIN = int(_META.get("title_min", 50))
TITLE_MAX = int(_META.get("title_max", 100))
DESC_MIN = int(_META.get("desc_min", 170))
DESC_MAX = int(_META.get("desc_max", 250))
CANON_IGNORE_PARAMS = set(_CANON.get("ignore_query_params", ["PAGEN_1", "PAGEN_2", "PAGEN", "page"]))
CANON_STRIP_TRAILING_SLASH = bool(_CANON.get("strip_trailing_slash", True))


def group_key(u):
    """Нормализованный ключ страницы для группировки дублей: без служебных параметров и trailing slash."""
    p = urlparse(u)
    query = [(k, v) for k, v in parse_qsl(p.query) if k not in CANON_IGNORE_PARAMS]
    path = p.path
    if CANON_STRIP_TRAILING_SLASH and len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")
    return urlunparse((p.scheme, p.netloc, path, "", urlencode(query), ""))


def extract_canonical(soup, page_url):
    """Абсолютный URL из rel=canonical, или пустая строка."""
    el = soup.find("link", attrs={"rel": re.compile("^canonical$", re.I)})
    if not el or not el.get("href"):
        return ""
    href = el["href"].strip()
    if not href:
        return ""
    abs_url = urljoin(page_url, href)
    p = urlparse(abs_url)
    return urlunparse((p.scheme, p.netloc, p.path or "/", "", p.query, ""))


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


def detect_brand(home_title, host, explicit=None):
    if explicit:
        return explicit.strip()
    if home_title and home_title.strip().lower() not in GENERIC_TITLES:
        for sep in ("|", "—", "–", "-", "::"):
            if sep in home_title:
                return home_title.split(sep)[-1].strip()
        return home_title.strip()[:40]
    name = host.replace("www.", "").split(".")[0]
    return name[:1].upper() + name[1:]


def derive_topic(url, h1, section):
    if h1 and h1.strip().lower() not in GENERIC_TITLES and len(h1.strip()) > 2:
        return h1.strip()
    u = url.lower()
    m = re.search(r"gost(\d+)", u)
    if m:
        return "ГОСТ " + m.group(1)
    if section and section not in ("Главная", "Главная (тех. дубль)", "Прочее"):
        return section
    return section


def trim_title(topic, brand, extra=None):
    parts = [topic]
    if extra and extra.lower() not in topic.lower():
        parts.append(extra)
    base = " — ".join(parts)
    budget = TITLE_MAX - len(" | " + brand)
    if len(base) > budget:
        base = base[:budget].rstrip(" ,|—-")
    return f"{base} | {brand}"


def make_description(topic, text, brand):
    text = re.sub(r"\s+", " ", text or "").strip()
    sentences = re.split(r"(?<=[.!?])\s+", text)
    uniq = []
    for s in sentences:
        s = s.strip()
        if len(s) < 25:
            continue
        if s.lower() in [u.lower() for u in uniq]:
            continue
        uniq.append(s)
    out = ""
    for s in uniq:
        if len(out) + len(s) + 1 <= 165:
            out = (out + " " + s).strip()
        else:
            break
        if len(out) >= 120:
            break
    if not out:
        out = f"{topic} — актуальная информация и услуги компании {brand}."
    if not out.endswith((".", "!", "?")):
        out += "."
    if len(out) < DESC_MIN:
        add = f" Компания {brand} предлагает качественные решения и индивидуальный подход."
        if len(out) + len(add) <= DESC_MAX:
            out += add
    return out[:DESC_MAX]


# ---------- семантическое ядро ----------
def load_semcore(path, host):
    """Возвращает dict: canon url -> [(query, freq)], и общий список запросов по убыванию частоты."""
    rows = []
    if path.lower().endswith((".xlsx", ".xls")):
        wb = load_workbook(path, read_only=True, data_only=True)
        ws = wb.active
        it = ws.iter_rows(values_only=True)
        header = next(it, None)
        rows = list(it)
    else:
        with open(path, encoding="utf-8-sig", newline="") as f:
            rd = list(csv.reader(f, delimiter=";"))
            if len(rd) < 1 or len(rd[0]) < 2:
                rd = list(csv.reader(open(path, encoding="utf-8-sig"), delimiter=","))
            header = rd[0] if rd else []
            rows = rd[1:]

    def col(names):
        for i, h in enumerate(header or []):
            if h and any(n.lower() in str(h).lower() for n in names):
                return i
        return None

    qi = col(["запрос", "query", "ключ"])
    fi = col(["частотность (общая)", "частотность общая", "общая"])
    ui = col(["уточнённая", "уточненная", "точная"])
    ti = col(["целевая", "url", "страница"])
    mapping = defaultdict(list)
    if qi is None:
        return mapping
    for r in rows:
        if not r or (r[qi] is None):
            continue
        q = str(r[qi]).strip()
        if not q:
            continue
        try:
            freq = int(float(str(r[fi]).replace(" ", ""))) if fi is not None and r[fi] not in (None, "") else 0
        except Exception:
            freq = 0
        if not freq and ui is not None:
            try:
                freq = int(float(str(r[ui]).replace(" ", ""))) if r[ui] not in (None, "") else 0
            except Exception:
                freq = 0
        target = str(r[ti]).strip() if ti is not None and r[ti] else ""
        if target.startswith("http"):
            mapping[canon(target, host)].append((q, freq))
    for k in mapping:
        mapping[k].sort(key=lambda x: -x[1])
    return mapping


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
    doc.add_heading("2.3. Служебные теги", level=2)
    doc.add_paragraph(
        "Служебные теги — это title и description страницы. Title — главный заголовок сниппета и один из "
        "сильнейших факторов релевантности: он отображается в выдаче и влияет на кликабельность. "
        "Description — описание сниппета, которое участвует в формировании клика. Качественные теги "
        "уникальны для каждой страницы, соответствуют её содержимому, содержат целевые запросы и "
        "укладываются в рекомендуемую длину: title — 50–70 символов, description — 150–170 (до 200). "
        "Пустые, дублирующиеся, шаблонные или обрезанные теги снижают релевантность, «склеивают» "
        "страницы в выдаче и ухудшают CTR."
    )
    p = doc.add_paragraph(); p.add_run("В ходе проверки выявлены следующие проблемы:").bold = True
    for b in summary["problems"]:
        doc.add_paragraph(b, style="List Bullet")
    p = doc.add_paragraph(); r = p.add_run("Рекомендация: "); r.bold = True
    p.add_run("привести title и description к единым правилам:")
    for b in summary["recommendations"]:
        doc.add_paragraph(b, style="List Bullet")
    if summary["semcore_note"]:
        doc.add_paragraph(summary["semcore_note"])
    if summary["examples"]:
        doc.add_paragraph()
        cap = doc.add_paragraph(); cap.add_run("Таблица 1. Примеры страниц с проблемами служебных тегов").bold = True
        t = doc.add_table(rows=1, cols=4); t.style = "Table Grid"
        for i, h in enumerate(["Страница", "Текущий title", "Проблема", "Скорректированный title"]):
            c = t.rows[0].cells[i]; c.text = h
            for par in c.paragraphs:
                for run in par.runs:
                    run.bold = True
        for e in summary["examples"]:
            cells = t.add_row().cells
            cells[0].text = e["url"]; cells[1].text = e["cur"]; cells[2].text = e["problem"]; cells[3].text = e["new"]
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
    ap.add_argument("--semcore", default="")
    ap.add_argument("--brand", default="")
    ap.add_argument("--cache", default="", help="каталог HTTP-кэша (общий для всех пунктов аудита); пусто — без кэша")
    args = ap.parse_args()

    base = args.url if args.url.endswith("/") else args.url + "/"
    host = urlparse(base).netloc
    os.makedirs(args.out_dir, exist_ok=True)
    semcore = load_semcore(args.semcore, host) if args.semcore and os.path.exists(args.semcore) else {}

    print(f"[1/3] Сбор URL: {base}")
    html_map = collect_pages(base, host, cache_dir=args.cache)
    print(f"      найдено URL: {len(html_map)}")

    pages = []
    home_title = ""
    for u, html in html_map.items():
        try:
            soup = BeautifulSoup(html, "html.parser")
            title = soup.title.string.strip() if soup.title and soup.title.string else ""
            md = soup.find("meta", attrs={"name": re.compile("^description$", re.I)})
            ogd = soup.find("meta", attrs={"property": "og:description"})
            desc = (md.get("content") if md else "") or (ogd.get("content") if ogd else "")
            h1 = soup.find("h1")
            h1 = h1.get_text(" ", strip=True) if h1 else ""
            el = None
            for sel in ("#content-column-left", "#content", "main", "article"):
                el = soup.select_one(sel)
                if el:
                    break
            text = el.get_text(" ", strip=True) if el else ""
            canonical = extract_canonical(soup, u)
            if not home_title and canon(u, host) == canon(base, host):
                home_title = title
            pages.append({"url": u, "section": classify(u, host), "title": title.strip(),
                          "desc": (desc or "").strip(), "h1": h1, "text": text,
                          "canonical": canonical})
        except Exception as e:
            print("   !", u, e)

    brand = detect_brand(home_title, host, args.brand or None)
    total = len(pages)
    print(f"[2/3] Анализ метатегов: страниц {total}; бренд: {brand}")

    titles = Counter(p["title"].lower() for p in pages if p["title"])
    descs = Counter(p["desc"].lower() for p in pages if p["desc"])
    no_title = sum(1 for p in pages if not p["title"])
    no_desc = sum(1 for p in pages if not p["desc"])
    generic = sum(1 for p in pages if p["title"].strip().lower() in GENERIC_TITLES)
    long_t = sum(1 for p in pages if len(p["title"]) > TITLE_MAX)
    short_t = sum(1 for p in pages if p["title"] and len(p["title"]) < TITLE_MIN)
    long_d = sum(1 for p in pages if len(p["desc"]) > DESC_MAX)
    short_d = sum(1 for p in pages if p["desc"] and len(p["desc"]) < DESC_MIN)
    no_period = sum(1 for p in pages if p["desc"] and not p["desc"].rstrip().endswith((".", "!", "?")))

    # Страница не считается проблемным дублом title/description, если на неё
    # стоит rel=canonical на другую страницу группы (пагинация, слэш/без слэша,
    # фильтры и т.п.). Остальные — реальные дубли.
    def page_is_canon_clone(p):
        c = p.get("canonical") or ""
        return bool(c) and group_key(c) != group_key(p["url"])

    dup_title_pages, dup_desc_pages = [], []
    for p in pages:
        t = p["title"].lower()
        d = p["desc"].lower()
        if p["title"] and titles[t] > 1:
            group = [q for q in pages if q["title"].lower() == t]
            if page_is_canon_clone(p):
                c = p["canonical"]
                if any(group_key(q["url"]) == group_key(c) for q in group):
                    pass  # клон с канонической ссылкой — не дубль
                else:
                    dup_title_pages.append(p)
            else:
                dup_title_pages.append(p)
        if p["desc"] and descs[d] > 1:
            group = [q for q in pages if q["desc"].lower() == d]
            if page_is_canon_clone(p):
                c = p["canonical"]
                if any(group_key(q["url"]) == group_key(c) for q in group):
                    pass
                else:
                    dup_desc_pages.append(p)
            else:
                dup_desc_pages.append(p)
    dup_title_urls = {p["url"] for p in dup_title_pages}
    dup_desc_urls = {p["url"] for p in dup_desc_pages}
    dup_title = len(dup_title_pages)
    dup_desc = len(dup_desc_pages)

    for p in pages:
        probs = []
        if not p["title"]:
            probs.append("нет title")
        else:
            if p["title"].strip().lower() in GENERIC_TITLES:
                probs.append("шаблонный/неинформативный title")
            if titles[p["title"].lower()] > 1 and p["url"] in dup_title_urls:
                probs.append("дубль title")
            if len(p["title"]) > TITLE_MAX:
                probs.append(f"title длиннее {TITLE_MAX} симв.")
            if len(p["title"]) < TITLE_MIN:
                probs.append(f"title короче {TITLE_MIN} симв.")
        if not p["desc"]:
            probs.append("нет description")
        else:
            if descs[p["desc"].lower()] > 1 and p["url"] in dup_desc_urls:
                probs.append("дубль description")
            if len(p["desc"]) > DESC_MAX:
                probs.append(f"description длиннее {DESC_MAX} симв.")
            if len(p["desc"]) < DESC_MIN:
                probs.append(f"description короче {DESC_MIN} симв.")
            if not p["desc"].rstrip().endswith((".", "!", "?")):
                probs.append("нет точки в конце description")
        p["problems"] = probs

        # корректировка
        queries = semcore.get(canon(p["url"], host), [])
        if queries:
            top = queries[0][0]
            tparts = [q for q, _ in queries[:2]]
            new_topic = " / ".join(dict.fromkeys(tparts))[:60]
            new_title = trim_title(new_topic, brand)
            new_desc = make_description(top, " ".join(q for q, _ in queries[:5]) + ".", brand)
            src = "семантика"
        else:
            topic = derive_topic(p["url"], p["h1"], p["section"])
            section = p["section"]
            if section in ("Главная", "Главная (тех. дубль)"):
                new_title = f"{brand} — официальный сайт"
            else:
                extra = section if section not in (topic, "Прочее") else None
                new_title = trim_title(topic, brand, extra=extra)
            new_desc = make_description(topic, p["text"], brand)
            src = "правила"
        p["new_title"], p["new_desc"], p["src"] = new_title, new_desc, src

    need_fix = sum(1 for p in pages if p["problems"])
    problems = [
        f"Title: отсутствует на {no_title} страницах; дублируется (без канонической ссылки) на {dup_title} страницах; "
        f"шаблонный/неинформативный — {generic}; длиннее {TITLE_MAX} символов — {long_t}; короче {TITLE_MIN} — {short_t}.",
        f"Description: отсутствует на {no_desc} страницах; дублируется (без канонической ссылки) на {dup_desc} страницах; "
        f"короче {DESC_MIN} символов — {short_d}; длиннее {DESC_MAX} символов — {long_d}; "
        f"без точки в конце — {no_period}.",
        f"Шаблонность: одинаковый title на множестве страниц ({len(titles)} уникальных title на {total} страниц)."
        if titles and max(titles.values()) > 1 else "Уникальность title: серьёзных проблем не выявлено.",
        f"Всего требуется доработка тегов на {need_fix} из {total} страниц.",
    ]
    if total and need_fix == 0:
        problems = ["Проблем на сайте не обнаружено, исправления не требуются."]
    recommendations = [
        "Title: " + str(TITLE_MIN) + "–" + str(TITLE_MAX) + " символов, уникальный для каждой страницы, с главным запросом в начале и названием "
        "компании после разделителя «|».",
        "Description: " + str(DESC_MIN) + "–" + str(DESC_MAX) + " символов, уникальный, по сути страницы, с ключевыми запросами, "
        "заканчивается точкой.",
        "Заполнить теги на всех страницах, убрать дубли и «неинформативные» шаблоны (например, «Компания»). "
        "Страницы с rel=canonical на главный URL (пагинация, фильтры) не считаются дублями.",
        "Составлять теги по семантическому ядру: на каждую страницу — свой кластер запросов "
        "(ТОП по частотности — в title, остальные — в description).",
        "Листы «Текущие метатеги» и «Скорректированные метатеги» в «Контент_<хост>.xlsx» — рабочие: "
        "по ним вносить теги в CMS.",
    ]
    semcore_note = ("Теги составлены по приложенному семантическому ядру." if semcore
                    else "Теги составлены по базовым правилам; при наличии семантического ядра рекомендуется "
                         "пересобрать их повторно (повысится релевантность).")

    examples = []
    for p in sorted(pages, key=lambda x: -len(x["problems"]))[:12]:
        if not p["problems"]:
            continue
        examples.append({"url": p["url"], "cur": (p["title"] or "—")[:60],
                         "problem": "; ".join(p["problems"]), "new": p["new_title"][:60]})

    # xlsx
    xlsx = os.path.join(args.out_dir, f"Контент_{host}.xlsx")
    wb = load_workbook(xlsx) if os.path.exists(xlsx) else Workbook()
    if not os.path.exists(xlsx):
        wb.remove(wb.active)
    cur_rows = [[i, p["url"], p["section"], p["title"] or "—", len(p["title"]), p["desc"] or "—",
                 len(p["desc"]), "; ".join(p["problems"]) or "—"]
                for i, p in enumerate(sorted(pages, key=lambda x: x["url"]), 1)]
    write_sheet(wb, "Текущие метатеги",
                ["№", "URL", "Раздел", "Title", "Длина title", "Description", "Длина description", "Проблемы"],
                cur_rows, [5, 44, 20, 50, 12, 60, 16, 46])

    systemic = total > 0 and (need_fix >= max(1, int(total * 0.8)) or bool(semcore))
    if systemic:
        fix_rows = [[i, p["url"], p["section"], p["new_title"], len(p["new_title"]), p["new_desc"],
                     len(p["new_desc"]), p["src"]]
                    for i, p in enumerate(sorted(pages, key=lambda x: x["url"]), 1)]
        write_sheet(wb, "Скорректированные метатеги",
                    ["№", "URL", "Раздел", "Title (новый)", "Длина", "Description (новый)", "Длина", "Источник"],
                    fix_rows, [5, 44, 20, 50, 10, 60, 10, 12])
    wb.save(xlsx)

    month_ru = {"January": "Январь", "February": "Февраль", "March": "Март", "April": "Апрель",
                "May": "Май", "June": "Июнь", "July": "Июль", "August": "Август", "September": "Сентябрь",
                "October": "Октябрь", "November": "Ноябрь", "December": "Декабрь"}.get(
        datetime.now().strftime("%B"), datetime.now().strftime("%B"))
    summary = {"host": host, "month": f"{month_ru} {datetime.now().year}", "problems": problems,
               "recommendations": recommendations, "examples": examples, "semcore_note": semcore_note}
    print("[3/3] Сохранение результатов")
    build_docx(os.path.join(args.out_dir, "Служебные теги.docx"), base, summary)
    print("Готово:")
    print("  -", os.path.join(args.out_dir, "Служебные теги.docx"))
    print("  -", xlsx)
    print("  листы:", "Текущие метатеги" + (", Скорректированные метатеги" if systemic else " (системных правок не требуется)"))


if __name__ == "__main__":
    main()
