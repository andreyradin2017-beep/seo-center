#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Пункт 2.1 «Текстовый контент сайта» (технический SEO-аудит, методология «Текарт»).

Собирает все страницы сайта (sitemap.xml, иначе — краулинг по внутренним ссылкам),
считает метрики текстового контента (объём, уникальность внутри сайта, вода, переспам,
частота публикации информационного контента) и сохраняет:
  - «Текстовый контент сайта.docx» — подводка, проблемы, рекомендации;
  - «Контент_<хост>.xlsx» — таблица всех страниц (лист «Текстовый контент»);
    этот же файл используется другими пунктами раздела контента (каждый пункт — свой лист).

Запуск:
  python3 content_audit.py --url https://www.roysol.ru/ --out-dir /путь/куда/сохранить
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

STOPWORDS = set("""
и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне
было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до
вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя
их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого
какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно
при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве
три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда
конечно всю между также этот весь всё всё-таки эта эти оно либо при том числе др т.д т.п при этом
""".split())

WATER_PHRASES = [
    "стоит отметить", "как известно", "в свою очередь", "в целом", "на сегодняшний день",
    "в связи с этим", "таким образом", "следует отметить", "в заключение", "в первую очередь",
    "ни для кого не секрет", "играет важную роль", "широкий ассортимент", "высокое качество",
    "индивидуальный подход", "гибкая система скидок", "гибкие цены", "динамично развивающаяся",
    "многолетний опыт", "команда профессионалов", "не секрет", "в современном мире",
    "хотелось бы отметить", "отдельно стоит", "на сегодняшний", "в наши дни",
]

MONTHS = {
    "января": 1, "февраля": 2, "марта": 3, "апреля": 4, "мая": 5, "июня": 6,
    "июля": 7, "августа": 8, "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12,
}


def norm(u):
    u, _ = urldefrag(u)
    return u


def canon(u, host):
    """Приводим к каноническому виду: https + базовый хост, без лишних параметров."""
    p = urlparse(u)
    query = p.query.strip("&")
    path = p.path or "/"
    return urlunparse(("https", host, path, "", query, ""))


def same_host(u, host):
    return urlparse(u).netloc in (host, host.replace("www.", ""), "www." + host.replace("www.", ""))


def skip_url(u):
    """Технические/служебные адреса, не являющиеся контентными страницами."""
    p = urlparse(u)
    path = p.path.lower()
    if path.startswith(("/tags/", "/jump", "/navi/", "/banners/", "/search")):
        return True
    if (path in ("", "/")) and p.query and "page=" not in p.query:
        return True
    return False


def get(url, timeout=25, cache_dir=None):
    return http_cache.get(url, headers=UA, timeout=timeout, allow_redirects=True, cache_dir=cache_dir)


def importance_rank(u, host):
    """Приоритет страницы для выборочной проверки (меньше — важнее)."""
    p = urlparse(u)
    path = p.path.lower()
    q = p.query.lower()
    if path in ("", "/") and not q:
        return 0  # главная
    if any(k in q for k in ("page=metal-roll", "page=salvage", "page=service", "page=suppliers",
                            "page=consumers", "page=complex_service")):
        return 1  # разделы/каталоги
    if "/news" in path or "/blog" in path or "/article" in path:
        return 4  # статьи/новости
    if "page=gost" in q:
        return 3
    return 2  # прочие страницы (карточки/подразделы)


def sample_urls(urls, limit, host):
    return sorted(urls, key=lambda u: (importance_rank(u, host), u))[:limit]


def collect_pages(base, host, timeout=25, workers=10, limit=0, cache_dir=None):
    """Параллельно обходит сайт (sitemap.xml + перелинковка). Возвращает {url: html}.
    При limit>0 проверяется не более limit наиболее важных страниц."""
    from concurrent.futures import ThreadPoolExecutor
    # 1) sitemap.xml (если есть)
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
            locs = [e.text.strip() for e in root.iter() if e.tag.endswith("loc") and e.text]
            for l in locs:
                if not l.lower().startswith("http"):
                    l = "https://" + l.lstrip("/") if not l.startswith("/") else urljoin(base, l)
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
        frontier = sample_urls(urls, limit, host) if limit else sorted(urls)
        while frontier and (not limit or len(html_map) < limit):
            results = list(ex.map(fetch, frontier))
            frontier = []
            for u, html in results:
                if not html:
                    continue
                if limit and len(html_map) >= limit:
                    break
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


def extract_main(soup):
    for sel in ["#content-column-left", "#content", "main", "article", ".content", ".article", ".news-detail"]:
        el = soup.select_one(sel)
        if el:
            for bad in el.select("script,style,nav,footer,form,.footer,.left-menu,.menu,.bread-crumbs,#bread-crumbs,.breadcrumbs,.route"):
                bad.decompose()
            txt = el.get_text(" ", strip=True)
            if len(txt) > 150:
                return txt
    for bad in soup(["script", "style", "nav", "footer", "header", "noscript"]):
        bad.decompose()
    return soup.get_text(" ", strip=True)


def find_date(soup, text):
    metas = [
        ('meta[property="article:published_time"]', "content"),
        ('meta[name="date"]', "content"),
        ('meta[itemprop="datePublished"]', "content"),
        ('meta[property="og:published_time"]', "content"),
        ('time', "datetime"),
    ]
    for sel, attr in metas:
        el = soup.select_one(sel)
        if el and el.get(attr):
            m = re.search(r"(20\d{2})[-./](\d{1,2})[-./](\d{1,2})", el.get(attr))
            if m:
                return f"{int(m.group(3)):02d}.{int(m.group(2)):02d}.{m.group(1)}"
    for m in re.finditer(r"\b(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d{2})\b", text):
        d, mo, y = int(m.group(1)), int(m.group(2)), m.group(3)
        if 1 <= d <= 31 and 1 <= mo <= 12:
            return f"{d:02d}.{mo:02d}.{y}"
    low = text.lower()
    for name, mo in MONTHS.items():
        m = re.search(r"(\d{1,2})\s+" + name + r"\s+(20\d{2})", low)
        if m:
            return f"{int(m.group(1)):02d}.{mo:02d}.{m.group(2)}"
    return ""


def classify(url, host):
    u = url.lower()
    pu = urlparse(u)
    if (u.rstrip("/") in (f"http://{host}", f"https://{host}") or pu.path in ("", "/")) and not pu.query:
        return "Главная", "коммерческий"
    if pu.path.endswith("/index.htm") or pu.path.endswith("/index.html"):
        return "Главная (тех. дубль)", "коммерческий"
    if "page=" in u:
        p = re.search(r"page=([^&]+)", u).group(1)
        if p in ("metal-roll",) or p.startswith("metalroll"):
            return "Металлопрокат", "коммерческий"
        if p.startswith("salvage"):
            return "Металлолом", "коммерческий"
        if p.startswith("gost"):
            return "ГОСТы / справка", "информационный"
        if p.startswith("suppliers"):
            return "Поставщики", "коммерческий"
        if p.startswith("consumers"):
            return "Потребители", "коммерческий"
        if p.startswith("service"):
            return "Услуги", "коммерческий"
        mapping = {
            "dele-m": ("О компании", "информационный"), "representations": ("Производственные площадки", "информационный"),
            "complex_service": ("Комплексное обслуживание", "коммерческий"), "order": ("Предварительный заказ", "служебный"),
            "job": ("Вакансии", "служебный"), "contacts": ("Контакты", "служебный"),
            "info": ("Полезная информация", "информационный"), "map": ("Карта сайта", "служебный"),
            "price": ("Прайс", "коммерческий"), "links": ("Ссылки", "служебный"),
        }
        if p in mapping:
            return mapping[p]
        return "Прочее", "информационный"
    if "/news" in u:
        return "Новости", "информационный"
    if "/search" in u:
        return "Поиск", "служебный"
    return "Прочее", "информационный"


def analyze(text):
    words = re.findall(r"[А-Яа-яЁёA-Za-z]{2,}", text)
    n = len(words)
    low = [w.lower() for w in words]
    stop = sum(1 for w in low if w in STOPWORDS)
    water_phr = sum(text.lower().count(p) for p in WATER_PHRASES)
    water = (stop / n * 100) if n else 0
    water += (water_phr / max(n, 1) * 100) * 3
    content_words = [w for w in low if w not in STOPWORDS and len(w) >= 4]
    top_word, top_cnt = ("", 0)
    if content_words:
        top_word, top_cnt = Counter(content_words).most_common(1)[0]
    top_share = (top_cnt / n * 100) if n else 0
    return {
        "chars": len(text), "words": n, "water": round(min(water, 100), 1),
        "top_word": top_word, "top_cnt": top_cnt, "top_share": round(top_share, 1),
    }


def shingles(text, k=5):
    words = re.findall(r"[а-яёa-z0-9]{2,}", text.lower())
    return {" ".join(words[i:i + k]) for i in range(max(0, len(words) - k + 1))}


def jaccard(a, b):
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / (len(a | b) or 1)


# ---------- docx ----------
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
    doc.add_heading("2.1. Текстовый контент сайта", level=2)
    doc.add_paragraph(
        "Текстовый контент — основа релевантности страницы: поисковые системы оценивают, насколько "
        "полно и уникально страница отвечает на запрос пользователя. На позиции влияют объём и "
        "полезность текста, его уникальность (в том числе отсутствие дублей и пересечений между "
        "страницами сайта), отсутствие «воды» и переспама, а также регулярность публикации "
        "информационного контента. Слабые, короткие, шаблонные или переоптимизированные тексты "
        "проигрывают конкурентам и не позволяют продвигаться по целевым запросам."
    )

    p = doc.add_paragraph(); p.add_run("В ходе проверки выявлены следующие проблемы:").bold = True
    for b in summary["problems"]:
        doc.add_paragraph(b, style="List Bullet")

    p = doc.add_paragraph(); r = p.add_run("Рекомендация: "); r.bold = True
    p.add_run("привести текстовый контент к требованиям поисковых систем:")
    for b in summary["recommendations"]:
        doc.add_paragraph(b, style="List Bullet")

    # таблица проблемных страниц
    if summary["worst"]:
        doc.add_paragraph()
        cap = doc.add_paragraph(); cap.add_run("Таблица 1. Страницы, требующие доработки текста").bold = True
        t = doc.add_table(rows=1, cols=5); t.style = "Table Grid"
        for i, h in enumerate(["Страница", "Объём, знаков", "Вода, %", "Переспам, %", "Примечание"]):
            c = t.rows[0].cells[i]; c.text = h
            for par in c.paragraphs:
                for run in par.runs:
                    run.bold = True
        for row in summary["worst"]:
            cells = t.add_row().cells
            cells[0].text = row["url"]; cells[1].text = str(row["chars"])
            cells[2].text = str(row["water"]); cells[3].text = str(row["top_share"])
            cells[4].text = row["note"]

    doc.save(path)


# ---------- xlsx ----------
def build_xlsx(path, sheet, rows):
    if os.path.exists(path):
        wb = load_workbook(path)
    else:
        wb = Workbook()
        wb.remove(wb.active)
    if sheet in wb.sheetnames:
        del wb[sheet]
    ws = wb.create_sheet(sheet, 0)
    headers = ["№", "URL", "Раздел", "Тип контента", "Объём, знаков", "Объём, слов",
               "Уникальность (внутр.), %", "Вода, %", "Переспам (топ-слово), %", "Топ-слово",
               "Частота топ-слова", "Дата публикации", "Примечание"]
    ws.append(headers)
    for c in ws[1]:
        c.font = Font(bold=True)
        c.alignment = Alignment(vertical="top")
    for i, r in enumerate(sorted(rows, key=lambda x: x["url"]), 1):
        ws.append([i, r["url"], r["section"], r["ctype"], r["chars"], r["words"],
                   r["uniqueness"], r["water"], r["top_share"], r["top_word"], r["top_cnt"],
                   r["date"], r["note"]])
    widths = [5, 46, 22, 16, 14, 12, 20, 10, 20, 16, 16, 16, 40]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[chr(64 + i) if i <= 26 else "A"].width = w
    ws.freeze_panes = "A2"
    wb.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--limit", type=int, default=0, help="проверять не более N наиболее важных страниц (0 = все)")
    ap.add_argument("--cache", default="", help="каталог HTTP-кэша (общий для всех пунктов аудита); пусто — без кэша")
    args = ap.parse_args()

    base = args.url if args.url.endswith("/") else args.url + "/"
    host = urlparse(base).netloc
    os.makedirs(args.out_dir, exist_ok=True)

    print(f"[1/3] Сбор URL: {base}")
    html_map = collect_pages(base, host, limit=args.limit, cache_dir=args.cache)
    print(f"      найдено URL: {len(html_map)}" + (f" (лимит {args.limit})" if args.limit else ""))

    pages = []
    for u, html in html_map.items():
        try:
            soup = BeautifulSoup(html, "html.parser")
            text = extract_main(soup)
            section, ctype = classify(u, host)
            m = analyze(text)
            m.update({"url": u, "section": section, "ctype": ctype,
                      "date": find_date(soup, text), "shingles": shingles(text)})
            pages.append(m)
        except Exception as e:
            print("   !", u, e)

    print(f"[2/3] Анализ текста: страниц с контентом {len(pages)}")

    # внутренняя уникальность
    for p in pages:
        mx = 0.0
        for q in pages:
            if q is p:
                continue
            j = jaccard(p["shingles"], q["shingles"])
            if j > mx:
                mx = j
        p["uniqueness"] = round((1 - mx) * 100, 1) if p["chars"] >= 300 else round((1 - mx) * 100, 1)

    # примечания/проблемы
    short_limit = 1500
    for p in pages:
        notes = []
        if p["chars"] < 800:
            notes.append("очень мало текста")
        elif p["chars"] < short_limit:
            notes.append("мало текста")
        if p["water"] > 18:
            notes.append("много воды")
        if p["top_share"] > 5:
            notes.append("переспам")
        if p["uniqueness"] < 70:
            notes.append("низкая уникальность (пересечение со страницами сайта)")
        p["note"] = "; ".join(notes) or "—"

    total = len(pages)
    n_short = sum(1 for p in pages if p["chars"] < short_limit)
    n_water = sum(1 for p in pages if p["water"] > 18)
    n_spam = sum(1 for p in pages if p["top_share"] > 5)
    n_lowuniq = sum(1 for p in pages if p["uniqueness"] < 70)
    info_pages = [p for p in pages if p["ctype"] == "информационный"]
    pub_pages = [p for p in pages if re.search(r"/news/\d+/?$", p["url"]) or "/blog/" in p["url"] or "/article" in p["url"]]
    pub_dates = sorted([p["date"] for p in pub_pages if p["date"]], key=lambda d: (d[6:], d[3:5], d[:2]))
    avg_chars = round(sum(p["chars"] for p in pages) / total) if total else 0
    info_avg = round(sum(p["chars"] for p in info_pages) / len(info_pages)) if info_pages else 0

    if not pub_pages:
        productivity = "информационный раздел (новости/блог/статьи) отсутствует"
    elif len(pub_dates) >= 2:
        try:
            first = datetime.strptime(pub_dates[0], "%d.%m.%Y")
            last = datetime.strptime(pub_dates[-1], "%d.%m.%Y")
            months = max(1, (last.year - first.year) * 12 + (last.month - first.month))
            rate = (len(pub_dates) - 1) / months
            productivity = f"{len(pub_pages)} информационных публикаций; регулярность ~{rate:.1f} в месяц (с {pub_dates[0]} по {pub_dates[-1]})"
        except Exception:
            productivity = f"{len(pub_pages)} информационных публикаций"
    else:
        productivity = (f"{len(pub_pages)} информационных публикаций; даты публикаций на страницах не указаны "
                        f"— регулярность оценить нельзя, публикации выглядят редкими")

    problems = []
    problems.append(f"Объём текста: в среднем ~{avg_chars} знаков на страницу; "
                    f"{n_short} из {total} страниц содержат менее {short_limit} знаков (в т.ч. страницы с очень коротким текстом).")
    problems.append(f"Уникальность внутри сайта: у {n_lowuniq} страниц тексты пересекаются с другими страницами сайта "
                    f"(коэффициент уникальности ниже 70%) — типично для шаблонных продуктовых страниц.")
    problems.append(f"«Вода»: у {n_water} страниц высокая доля воды (более 18%) — общие фразы и стоп-слова, "
                    f"не несущие смысла.")
    problems.append(f"Переспам: у {n_spam} страниц высокая частота повторения ключевого слова (более 5%) — "
                    f"признак переоптимизации.")
    problems.append(f"Информационный контент: {productivity}; средний объём информационной страницы ~{info_avg} знаков."
                    + ("" if info_pages else " Информационный раздел отсутствует."))

    if total and n_short == 0 and n_water == 0 and n_spam == 0 and n_lowuniq == 0:
        problems = ["Проблем на сайте не обнаружено, исправления не требуются."]

    recommendations = [
        "Уникализировать тексты продуктовых и услуговых страниц относительно друг друга — сделать их "
        "самодостаточными, убрать шаблонные повторы.",
        "Нарастить объём: ориентир — не менее 1500–2000 знаков для коммерческих страниц и не менее "
        "3000–5000 знаков для информационных (смотреть на конкурентов из ТОП).",
        "Убрать «воду» и общие фразы; использовать конкретику: характеристики, факты, цифры, выгоды.",
        "Снизить переспам: следить за частотой ключевых слов (обычно не более 2–3%) и использовать "
        "синонимы и словоформы.",
        "Регулярно публиковать экспертный информационный контент (blog/статьи/новости) по поисковому "
        "спросу, с перелинковкой на продуктовые и услуговые страницы.",
        "Добавлять блок FAQ и структурировать текст заголовками H2–H3 для лучшего восприятия и ИИ-выдач.",
        "Использовать таблицу «Контент_<хост>.xlsx» как единый рабочий файл по контенту: другие пункты "
        "раздела (оформление текста, служебные теги, изображения и т.д.) добавляются отдельными листами.",
    ]

    worst = sorted([p for p in pages if p["note"] != "—"],
                   key=lambda p: (p["chars"], -p["top_share"]))[:15]

    summary = {
        "host": host, "month": datetime.now().strftime("%B %Y"),
        "problems": problems, "recommendations": recommendations, "worst": worst,
    }
    summary["month"] = {
        "January": "Январь", "February": "Февраль", "March": "Март", "April": "Апрель",
        "May": "Май", "June": "Июнь", "July": "Июль", "August": "Август",
        "September": "Сентябрь", "October": "Октябрь", "November": "Ноябрь", "December": "Декабрь",
    }.get(datetime.now().strftime("%B"), datetime.now().strftime("%B")) + " " + str(datetime.now().year)

    print("[3/3] Сохранение результатов")
    build_xlsx(os.path.join(args.out_dir, f"Контент_{host}.xlsx"), "Текстовый контент", pages)
    build_docx(os.path.join(args.out_dir, "Текстовый контент сайта.docx"), base, pages, summary)
    print("Готово:")
    print("  -", os.path.join(args.out_dir, "Текстовый контент сайта.docx"))
    print("  -", os.path.join(args.out_dir, f"Контент_{host}.xlsx"))


if __name__ == "__main__":
    main()
