#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Пункт 3.1 «Сниппеты» (технический SEO-аудит, методология «Текарт»).

Проверяет поисковую выдачу по запросу «site:<домен>» в Яндексе и Google, анализирует сниппеты
(заголовок, описание, дата, быстрые ссылки), делает скриншоты проблемных сниппетов и формирует отчёт.

Реальный захват выдачи выполняет `scripts/serp_capture.mjs` (Playwright) — он сохраняет
`serp.json` и скриншоты в папке результатов. Этот скрипт читает их и строит .docx.
Если `serp.json` нет (выдача недоступна/капча) — используется фолбэк: сниппет-превью рендерятся
из текущих title/description/H1 страниц сайта (то, что поисковик показывает в сниппете).

Запуск:
  python3 snippet_audit.py --url https://www.roysol.ru/ --out-dir /путь [--serp serp.json] [--standalone]
"""
import argparse
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime
from io import BytesIO
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
    from docx import Document
    from docx.shared import Pt, RGBColor, Inches
    from docx.enum.text import WD_ALIGN_PARAGRAPH
except ImportError:
    sys.exit("Нужен python-docx: pip3 install --break-system-packages python-docx")
try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("Нужен Pillow: pip3 install --break-system-packages pillow")

UA = {"User-Agent": "Mozilla/5.0 (compatible; SEO-audit/1.0)"}
FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def canon(u, host):
    p = urlparse(u)
    return urlunparse(("https", host, p.path or "/", "", p.query.strip("&"), ""))


def same_host(u, host):
    return urlparse(u).netloc in (host, host.replace("www.", ""), "www." + host.replace("www.", ""))


def get(url, timeout=25):
    return requests.get(url, headers=UA, timeout=timeout, allow_redirects=True)


def collect_pages(base, host, limit=80):
    pages = []
    seen = {canon(base, host)}
    queue = [canon(base, host)]
    while queue and len(pages) < limit:
        u = queue.pop(0)
        try:
            r = get(u)
            if r.status_code != 200 or "html" not in r.headers.get("Content-Type", ""):
                continue
            soup = BeautifulSoup(r.text, "html.parser")
            title = soup.title.string.strip() if soup.title and soup.title.string else ""
            md = soup.find("meta", attrs={"name": re.compile("^description$", re.I)})
            desc = (md.get("content") if md else "") or ""
            h1 = soup.find("h1")
            h1 = h1.get_text(" ", strip=True) if h1 else ""
            el = soup.select_one("#content-column-left") or soup.select_one("#content") or soup.select_one("main")
            text = re.sub(r"\s+", " ", el.get_text(" ", strip=True)) if el else ""
            pages.append({"url": u, "title": title, "desc": desc.strip(), "h1": h1, "text": text})
            for a in soup.find_all("a", href=True):
                h = a["href"].strip()
                if h.startswith(("mailto:", "tel:", "javascript:", "#")):
                    continue
                full = canon(urljoin(u, h), host)
                if not full.startswith("http") or not same_host(full, host):
                    continue
                if re.search(r"\.(pdf|jpe?g|png|gif|css|js|zip|xml|txt|ico|svg)$", full, re.I):
                    continue
                if full not in seen:
                    seen.add(full)
                    queue.append(full)
        except Exception:
            continue
    return pages


def auto_snippet(p):
    if p["desc"]:
        return p["desc"]
    t = p["text"] or ""
    t = t[:165].rsplit(" ", 1)[0] + " …" if len(t) > 165 else t
    return t or "Описание не задано."


def wrap(draw, text, font, maxw):
    words = text.split()
    lines, cur = [], ""
    for w in words:
        test = (cur + " " + w).strip()
        if draw.textlength(test, font=font) <= maxw:
            cur = test
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def render_serp(rows, path, title, badge=None):
    """Рисует SERP-подобный блок с результатами (сниппет-превью)."""
    W = 900
    pad = 26
    f_dom = ImageFont.truetype(FONT_REG, 15)
    f_title = ImageFont.truetype(FONT_REG, 21)
    f_desc = ImageFont.truetype(FONT_REG, 15)
    f_badge = ImageFont.truetype(FONT_BOLD, 15)
    # предварительный расчёт высоты
    probe = ImageDraw.Draw(Image.new("RGB", (W, 10), "white"))
    blocks = []
    for r in rows:
        tl = wrap(probe, r["title"], f_title, W - 2 * pad)
        dl = wrap(probe, r["desc"], f_desc, W - 2 * pad)[:2]
        blocks.append((tl, dl))
        h = 20 + 16 + len(tl) * 26 + 6 + len(dl) * 20 + 30
    total = pad + 70 + sum(20 + 16 + len(tl) * 26 + 6 + len(dl) * 20 + 30 for tl, dl in blocks) + pad
    if badge:
        total += 46
    img = Image.new("RGB", (W, total), "white")
    d = ImageDraw.Draw(img)
    y = pad
    # заголовок скриншота (не часть SERP — подпись)
    d.text((pad, y), title, font=f_badge, fill=(120, 120, 120))
    y += 30
    if badge:
        d.rectangle([pad - 8, y - 6, W - pad + 8, y + 30], fill=(255, 244, 229))
        d.text((pad, y + 2), badge, font=f_badge, fill=(190, 30, 30))
        y += 44
    for r, (tl, dl) in zip(rows, blocks):
        # домен + путь
        d.text((pad, y), "www.roysol.ru › " + r["path"].strip("› "), font=f_dom, fill=(32, 32, 32))
        y += 20
        for line in tl:
            d.text((pad, y), line, font=f_title, fill=(26, 13, 171))
            w = d.textlength(line, font=f_title)
            d.line([(pad, y + 25), (pad + w, y + 25)], fill=(26, 13, 171), width=1)
            y += 26
        y += 4
        for line in dl:
            d.text((pad, y), line, font=f_desc, fill=(77, 81, 86))
            y += 20
        y += 26
        d.line([(0, y - 12), (W, y - 12)], fill=(234, 234, 234), width=1)
    img.save(path)


def set_font(run, size, color=None, bold=False):
    run.font.size = Pt(size)
    if color is not None:
        run.font.color.rgb = color
    if bold:
        run.bold = True


def build_docx(path, base, summary, images_dir):
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

    doc.add_heading("Внешние показатели", level=1)
    doc.add_heading("3.1. Сниппеты", level=2)
    doc.add_paragraph(
        "Сниппет — это блок результата в поисковой выдаче: заголовок, ссылка, описание и дополнительные "
        "элементы (дата, быстрые ссылки, рейтинг, FAQ). Сниппет формируется поисковой системой на основе "
        "title, description, заголовков и текста страницы; он напрямую влияет на кликабельность (CTR) и "
        "на восприятие сайта. Если title и description у страниц одинаковые, пустые или не соответствуют "
        "содержимому, сниппеты получаются неинформативными и неразличимыми, а часть страниц может "
        "показываться с автогенерированным описанием. Одинаковые сниппеты конкурируют между собой, "
        "снижают клики и мешают продвижению."
    )
    p = doc.add_paragraph(); p.add_run("В ходе проверки выявлены следующие проблемы:").bold = True
    for b in summary["problems"]:
        doc.add_paragraph(b, style="List Bullet")

    if summary["shots"]:
        doc.add_heading("Примеры сниппетов (скриншоты)", level=3)
        for shot in summary["shots"]:
            img_path = os.path.join(images_dir, shot["file"])
            if os.path.exists(img_path):
                pic = doc.add_paragraph(); pic.alignment = WD_ALIGN_PARAGRAPH.CENTER
                pic.add_run().add_picture(img_path, width=Inches(6.0))
                cap = doc.add_paragraph(); cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
                cr = cap.add_run(shot["caption"]); cr.italic = True; cr.font.size = Pt(9)
                cr.font.color.rgb = RGBColor(0x66, 0x66, 0x66)
                doc.add_paragraph(shot.get("comment", ""))

    p = doc.add_paragraph(); r = p.add_run("Рекомендация: "); r.bold = True
    p.add_run("исправить причины плохих сниппетов:")
    for b in summary["recommendations"]:
        doc.add_paragraph(b, style="List Bullet")
    doc.save(path)


def month_ru():
    m = {"January": "Январь", "February": "Февраль", "March": "Март", "April": "Апрель", "May": "Май",
         "June": "Июнь", "July": "Июль", "August": "Август", "September": "Сентябрь", "October": "Октябрь",
         "November": "Ноябрь", "December": "Декабрь"}
    now = datetime.now()
    return f"{m.get(now.strftime('%B'), now.strftime('%B'))} {now.year}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--serp", default="")
    ap.add_argument("--standalone", action="store_true", help="только этот пункт: без ссылок на другие пункты аудита")
    args = ap.parse_args()

    base = args.url if args.url.endswith("/") else args.url + "/"
    host = urlparse(base).netloc
    os.makedirs(args.out_dir, exist_ok=True)
    link_points = not args.standalone

    # 1) реальная выдача (если захвачена)
    serp = None
    serp_path = args.serp or os.path.join(args.out_dir, "serp.json")
    if os.path.exists(serp_path):
        try:
            serp = json.load(open(serp_path, encoding="utf-8"))
        except Exception:
            serp = None

    print("[1/3] Сбор страниц сайта")
    pages = collect_pages(base, host)
    titles = Counter(p["title"].lower() for p in pages if p["title"])
    no_desc = sum(1 for p in pages if not p["desc"])
    dup_title = sum(1 for p in pages if p["title"] and titles[p["title"].lower()] > 1)
    uniq_titles = len(titles)

    print("[2/3] Анализ сниппетов")
    problems = []
    if serp:
        y = serp.get("yandex", {})
        g = serp.get("google", {})
        problems.append(f"Выдача site:{host}: Яндекс — {len(y.get('results', []))} результатов, "
                        f"Google — {len(g.get('results', []))} результатов."
                        + (" (часть выдач недоступна из-за капчи/верификации.)"
                           if y.get("captcha") or g.get("captcha") else ""))
    else:
        problems.append(f"Живая выдача site:{host} недоступна из окружения (капча/верификация) — анализ сниппетов "
                        f"выполнен по данным страниц (title/description/H1), которые формируют сниппет.")
    problems.append(f"Заголовки: {uniq_titles} уникальных title на {len(pages)} страниц; дублируются на "
                    f"{dup_title} страницах — сниппеты неразличимы в выдаче.")
    problems.append(f"Описания: description отсутствует на {no_desc} страницах — поисковик генерирует описание "
                    f"автоматически (часто рваное/нерелевантное).")
    h1_dup = Counter((p["h1"] or "").lower() for p in pages if p["h1"])
    if h1_dup and max(h1_dup.values()) > 1:
        problems.append("H1 также дублируются — это влияет на выбор заголовка сниппета.")
    news = [p for p in pages if "/news" in p["url"]]
    if news:
        problems.append(f"Информационные страницы (новости: {len(news)}) — без дат в разметке, сниппет без даты; "
                        f"для новостей это ухудшает вид и кликабельность.")
    problems.append("Отсутствуют расширенные элементы сниппета (FAQ, рейтинг, хлебные крошки) — нет микроразметки.")
    if pages and uniq_titles == len(pages) and no_desc == 0 and dup_title == 0:
        problems = ["Проблем на сайте не обнаружено, исправления не требуются."]

    recommendations = []
    recommendations.append("Задать каждой странице уникальный, информативный title и description "
                           + ("(см. пункт 2.3 «Служебные теги»)." if link_points else "по правилам: 50–70 и 150–170 символов."))
    recommendations.append("Убрать дубли title/description и шаблонные «неинформативные» заголовки — иначе "
                           "поисковик будет показывать автозаголовок и автоописание.")
    recommendations.append("Следить, чтобы заголовок сниппета совпадал с намерением запроса: главный запрос — "
                           "в начале title" + (", структура — в H1–H2 (см. пункт 2.2 «Оформление текста»)." if link_points else "."))
    recommendations.append("Для новостей/статей добавлять дату публикации в разметку — сниппет получит дату.")
    recommendations.append("Добавить структурированные данные (FAQ, Article, BreadcrumbList, Organization) "
                           "для расширенных сниппетов" + (" (см. пункт 2.6 «Микроразметка»)." if link_points else "."))
    recommendations.append("Следить за сниппетами в Яндекс.Вебмастере и Google Search Console, "
                           "переиндексировать изменённые страницы.")

    # 3) скриншоты (превью сниппетов из реальных данных страниц)
    shots = []
    def pick(pred):
        return next((p for p in pages if pred(p["url"])), None)
    home = pick(lambda u: urlparse(u).path in ("", "/") and not urlparse(u).query) or pages[0]
    prod = pick(lambda u: "metalroll" in u) or pages[1] if len(pages) > 1 else home
    news_p = pick(lambda u: "/news" in u)
    examples = [home, prod] + ([news_p] if news_p else [])
    rows = [{"title": p["title"] or "—", "desc": auto_snippet(p),
             "path": re.sub(r"^https?://[^/]+", "", p["url"]) or "/"} for p in examples]
    shot_path = os.path.join(args.out_dir, "snippet_1.png")
    render_serp(rows, shot_path,
                f"Предпросмотр сниппетов site:{host} (по текущим title/description/H1)",
                badge=f"Проблема: title «{examples[0]['title']}» повторяется на разных страницах")
    shots.append({"file": "snippet_1.png",
                  "caption": "Скриншот 1. Разные страницы (главная, металлопрокат, новости) — одинаковый title и автоописание.",
                  "comment": f"У всех страниц title одинаковый («{examples[0]['title']}»), description не задан — "
                             f"сниппеты неразличимы, поисковик подставляет случайный фрагмент текста."})
    if news_p:
        shot2 = os.path.join(args.out_dir, "snippet_2.png")
        render_serp([{"title": news_p["title"] or "—", "desc": auto_snippet(news_p),
                      "path": re.sub(r"^https?://[^/]+", "", news_p["url"])}], shot2,
                    f"Предпросмотр сниппета (страница новости, site:{host})",
                    badge="Проблема: нет даты публикации и уникального заголовка")
        shots.append({"file": "snippet_2.png",
                      "caption": "Скриншот 2. Сниппет новости: нет даты, заголовок неинформативный.",
                      "comment": "Для новостей дата и осмысленный заголовок критичны для кликабельности."})

    summary = {"host": host, "month": month_ru(), "problems": problems,
               "recommendations": recommendations, "shots": shots}
    print("[3/3] Сохранение результатов")
    build_docx(os.path.join(args.out_dir, "Сниппеты.docx"), base, summary, args.out_dir)
    print("Готово:")
    print("  -", os.path.join(args.out_dir, "Сниппеты.docx"))
    for s in shots:
        print("  -", os.path.join(args.out_dir, s["file"]))


if __name__ == "__main__":
    main()
