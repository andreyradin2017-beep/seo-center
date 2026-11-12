#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Пункт 3.2 «Внешние ссылки» (входящие, технический SEO-аудит, методология «Текарт»).

Без доступа к Яндекс.Вебмастеру полный профиль входящих ссылок недоступен. Скрипт собирает то, что
можно получить своими силами:
  - кандидатов-доноров из собственного каталога ссылок / обменных страниц сайта;
  - проверяет взаимность (реально ли донор ссылается обратно на сайт) и rel;
  - оценивает качество доноров (тематика, TLD, спам-признаки, размер ссылочного вывода);
и формирует отчёт с рекомендациями. Позже можно подключить источник (Яндекс.Вебмастер/экспорт) через --backlinks.

Запуск:
  python3 backlink_audit.py --url https://www.roysol.ru/ --out-dir /путь [--backlinks файл.csv] [--no-verify]
"""
import argparse
import csv
import os
import re
import sys
from collections import Counter, defaultdict
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

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"}
SUSPECT_TLD = (".info", ".biz", ".xyz", ".top", ".gq", ".cf", ".tk", ".ml", ".work", ".click", ".loan", ".bid", ".review")
SPAM_TOKENS = ("seo", "link", "links", "katalog", "catalog", "board", "directory", "buy", "cheap", "kredit", "credit",
               "zarabotok", "casino", "porn", "bazar", "tovar", "optom", "dengi")
THEME_TOKENS = ("metal", "metall", "stal", "truba", "shveller", "armatur", "prokat", "lom", "gost", "chern",
                "zhelez", "stan", "instrument", "zavod", "mkz", "mmk", "sever", "nlmk",
                "металл", "сталь", "труб", "швеллер", "арматур", "прокат", "лом", "гост", "чёрн", "черн",
                "желез", "стан", "инструмент", "завод", "метиз", "нефт", "биржа металл")
COUNTERS = ("mail.ru", "rambler.ru", "hotlog.ru", "liveinternet.ru", "openstat", "yandex.ru", "top100", "spylog")
WIDGETS = ("101widgets.com",)
SOCIAL = ("vk.com", "t.me", "telegram", "ok.ru", "facebook.com", "instagram.com", "youtube.com", "twitter.com")


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


def get(url, timeout=20, cache_dir=None):
    return http_cache.get(url, headers=UA, timeout=timeout, allow_redirects=True, cache_dir=cache_dir)


def crawl(base, host, limit=100, cache_dir=None):
    urls, seen = [], {canon(base, host)}
    queue = [canon(base, host)]
    while queue and len(urls) < limit:
        u = queue.pop(0)
        try:
            r = get(u, cache_dir=cache_dir)
            if r.status_code != 200 or "html" not in r.headers.get("Content-Type", ""):
                continue
            urls.append(u)
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
        except Exception:
            continue
    return urls


def collect_candidates(base, host, cache_dir=None):
    """Собирает домены-кандидаты из страниц с плотной внешней перелинковкой (каталог/обмен ссылками)."""
    candidates = {}  # domain -> {"anchor":..., "pages":set(), "site_pages":int}
    for u in crawl(base, host, cache_dir=cache_dir):
        try:
            r = get(u, cache_dir=cache_dir)
            soup = BeautifulSoup(r.text, "html.parser")
            ext = []
            for a in soup.find_all("a", href=True):
                h = a["href"].strip()
                if h.startswith(("mailto:", "tel:", "javascript:", "#")):
                    continue
                full = urljoin(u, h)
                dom = urlparse(full).netloc.lower().replace("www.", "")
                if not dom or same_host(full, host):
                    continue
                if any(c in dom for c in COUNTERS) or any(w in dom for w in WIDGETS) or any(s in dom for s in SOCIAL):
                    continue
                ext.append((dom, a.get_text(" ", strip=True)))
            doms = {d for d, _ in ext}
            if len(doms) >= 4:  # страница похожа на каталог/обмен
                for d, anchor in ext:
                    rec = candidates.setdefault(d, {"anchor": anchor, "pages": set()})
                    rec["pages"].add(canon(u, host))
                    if not rec["anchor"]:
                        rec["anchor"] = anchor
        except Exception:
            continue
    return candidates


def verify_backlink(domain, host, timeout=15, cache_dir=None):
    """Реально ли донор ссылается на сайт (главная + типовые страницы ссылок)."""
    out = {"status": "unreachable", "nofollow": "", "out_links": 0, "found": False}
    paths = ["/", "/links", "/partners"]
    for scheme in ("https", "http"):
        base = f"{scheme}://{domain}"
        reachable = False
        for path in paths:
            try:
                r = http_cache.get(base + path, headers=UA, timeout=timeout,
                                   allow_redirects=True, cache_dir=cache_dir)
                if r.status_code != 200 or "html" not in r.headers.get("Content-Type", ""):
                    continue
                reachable = True
                soup = BeautifulSoup(r.text, "html.parser")
                links = soup.find_all("a", href=True)
                if out["out_links"] == 0:
                    out["out_links"] = len({urlparse(urljoin(base + path, a['href'])).netloc
                                            for a in links if a['href'].startswith("http")})
                for a in links:
                    if registrable(host) in a["href"]:
                        out["found"] = True
                        rel = a.get("rel") or []
                        out["nofollow"] = "nofollow" if "nofollow" in [str(x).lower() for x in rel] else "dofollow"
                        out["status"] = "ok"
                        return out
            except Exception:
                continue
        if reachable:
            out["status"] = "ok"
            return out
    return out


def score_donor(dom, relevance, verified, out_links):
    score = 50
    reasons = []
    if any(dom.endswith(t) for t in SUSPECT_TLD):
        score -= 20; reasons.append("подозрительный домен 1-го уровня")
    if any(tok in dom for tok in SPAM_TOKENS):
        score -= 15; reasons.append("спам-признак в домене")
    if relevance:
        score += 20; reasons.append("тематический (релевантный)")
    else:
        score -= 10; reasons.append("нерелевантный тематике")
    if out_links > 100:
        score -= 25; reasons.append("очень много исходящих (ссылочная ферма)")
    elif out_links > 40:
        score -= 10; reasons.append("много исходящих ссылок")
    if verified.get("found"):
        score += 10; reasons.append("обратная ссылка подтверждена")
    else:
        score -= 5; reasons.append("обратная ссылка не подтверждена")
    score = max(0, min(100, score))
    cls = "Хорошая" if score >= 70 else ("Средняя" if score >= 40 else "Мусорная")
    return score, cls, reasons


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

    doc.add_heading("Внешние показатели", level=1)
    doc.add_heading("3.2. Внешние ссылки", level=2)
    doc.add_paragraph(
        "Внешние (входящие) ссылки влияют на авторитет сайта: поисковые системы "
        "оценивают их количество, качество и естественность. Ценность ссылки зависит от тематической "
        "близости донора, его качества и доверия, анкора и типа (dofollow/nofollow). Большое число "
        "нерелевантных, обменных и «мусорных» ссылок с низкокачественных площадок не помогает, а вредит: "
        "может восприниматься как манипуляция ссылочным весом. Поэтому важно понимать происхождение ссылок, "
        "отделять качественные источники от мусора и наращивать ссылочный профиль белыми методами."
    )
    doc.add_paragraph(summary["source_note"])
    p = doc.add_paragraph(); p.add_run("В ходе проверки выявлены следующие проблемы:").bold = True
    for b in summary["problems"]:
        doc.add_paragraph(b, style="List Bullet")
    if summary["examples"]:
        doc.add_paragraph()
        cap = doc.add_paragraph(); cap.add_run("Таблица 1. Найденные доноры и оценка качества").bold = True
        t = doc.add_table(rows=1, cols=5); t.style = "Table Grid"
        for i, h in enumerate(["Домен-донор", "Обратная ссылка", "Оценка", "Класс", "Комментарий"]):
            c = t.rows[0].cells[i]; c.text = h
            for par in c.paragraphs:
                for run in par.runs:
                    run.bold = True
        for e in summary["examples"]:
            cells = t.add_row().cells
            cells[0].text = e["domain"]; cells[1].text = e["verified"]; cells[2].text = str(e["score"])
            cells[3].text = e["cls"]; cells[4].text = e["reasons"]
    p = doc.add_paragraph(); r = p.add_run("Рекомендация: "); r.bold = True
    p.add_run("что делать с найденными ссылками и как наращивать профиль:")
    for b in summary["recommendations"]:
        doc.add_paragraph(b, style="List Bullet")
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


def load_backlinks(path, host):
    """Загрузка готового экспорта (URL/домен; CSV с ; или ,)."""
    rows = []
    if path.lower().endswith((".xlsx", ".xls")):
        wb = load_workbook(path, read_only=True, data_only=True)
        it = wb.active.iter_rows(values_only=True)
        header = next(it, None) or []
        for r in it:
            if not r:
                continue
            for cell in r:
                if cell and isinstance(cell, str) and cell.startswith("http"):
                    rows.append(cell)
                    break
    else:
        with open(path, encoding="utf-8-sig") as f:
            for line in f:
                m = re.search(r"https?://[^\s;,\"]+", line)
                if m:
                    rows.append(m.group(0))
    cand = {}
    for u in rows:
        dom = urlparse(u).netloc.lower().replace("www.", "")
        if dom and not same_host(u, host) and not any(c in dom for c in COUNTERS):
            cand.setdefault(dom, {"anchor": "", "pages": set()})
    return cand


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--backlinks", default="", help="готовый экспорт ссылок (позже: Вебмастер/Ahrefs и т.п.)")
    ap.add_argument("--no-verify", action="store_true", help="не проверять взаимность доноров")
    ap.add_argument("--max-donors", type=int, default=60)
    ap.add_argument("--cache", default="", help="каталог HTTP-кэша (общий для всех пунктов аудита); пусто — без кэша")
    args = ap.parse_args()

    base = args.url if args.url.endswith("/") else args.url + "/"
    host = urlparse(base).netloc
    os.makedirs(args.out_dir, exist_ok=True)

    source_note = ("Источник данных: собственный сбор — каталог/обменные страницы сайта + проверка взаимности. "
                   "Это не полный профиль входящих ссылок; для полноты подключите Яндекс.Вебмастер "
                   "(входящие ссылки) или экспорт из Ahrefs/Semrush/GSC (параметр --backlinks).")
    if args.backlinks and os.path.exists(args.backlinks):
        print(f"[1/3] Загрузка ссылок из файла: {args.backlinks}")
        candidates = load_backlinks(args.backlinks, host)
        source_note = "Источник данных: загруженный экспорт входящих ссылок (" + os.path.basename(args.backlinks) + ")."
    else:
        print("[1/3] Сбор кандидатов-доноров со страниц сайта")
        candidates = collect_candidates(base, host, cache_dir=args.cache)
    print(f"      уникальных доменов-кандидатов: {len(candidates)}")

    print("[2/3] Оценка качества доноров" + ("" if args.no_verify else " и проверка взаимности"))
    rows = []
    donors = list(candidates.items())[:args.max_donors]
    verif = {}
    if not args.no_verify and donors:
        from concurrent.futures import ThreadPoolExecutor, as_completed
        with ThreadPoolExecutor(max_workers=12) as ex:
            futs = {ex.submit(verify_backlink, dom, host, cache_dir=args.cache): dom for dom, _ in donors}
            for fu in as_completed(futs):
                verif[futs[fu]] = fu.result()
    for dom, rec in donors:
        anchor_l = (rec.get("anchor", "") or "").lower()
        relevance = any(t in dom for t in THEME_TOKENS) or any(t in anchor_l for t in THEME_TOKENS)
        verified = verif.get(dom, {"status": "skipped", "found": False, "nofollow": "", "out_links": 0})
        score, cls, reasons = score_donor(dom, relevance, verified, verified.get("out_links", 0))
        rows.append({"domain": dom, "verified": verified.get("status") != "unreachable" and verified.get("found"),
                     "nofollow": verified.get("nofollow", ""), "out_links": verified.get("out_links", 0),
                     "relevance": relevance, "score": score, "cls": cls, "reasons": reasons,
                     "anchor": rec.get("anchor", ""), "tld": dom.split(".")[-1]})

    total = len(rows)
    confirmed = sum(1 for r in rows if r["verified"])
    good = sum(1 for r in rows if r["cls"] == "Хорошая")
    mid = sum(1 for r in rows if r["cls"] == "Средняя")
    trash = sum(1 for r in rows if r["cls"] == "Мусорная")
    relevant = sum(1 for r in rows if r["relevance"])
    tlds = Counter(r["tld"] for r in rows)
    nofollow_all = sum(1 for r in rows if r["nofollow"] == "nofollow")

    problems = [
        f"Собрано доменов-доноров: {total}; из них реально ссылаются обратно (подтверждено): {confirmed}.",
        f"Тематическая релевантность: {relevant} из {total} доноров относятся к теме металлопроката/металлургии, "
        f"остальные — посторонние (окна, мебель, ноутбуки, строительство и т.п.).",
        f"Качество: хороших — {good}, средних — {mid}, мусорных — {trash}.",
        f"Профиль ссылок выглядит как обмен/каталог ссылок, а не естественные упоминания; "
        f"TLD-распределение: {', '.join(f'{k} — {v}' for k, v in tlds.most_common(6))}."
        if total else "Кандидаты не найдены.",
        ("Часть доноров недоступна/не подтверждена — оценка по ним неполная." if confirmed < total else
         "Все доноры проверены."),
    ]
    if total == 0:
        problems = ["Проблем на сайте не обнаружено, исправления не требуются."]
    recommendations = [
        "Провести чистку ссылочного профиля: нерелевантные и «мусорные» ссылки со обменных каталогов — "
        "снять (написать донорам) или добавить в disavow-файл (Google Search Console) и отклонить в Яндексе.",
        "Отказаться от массового обмена ссылками и каталогов: устаревшие схемы не дают роста и создают риск санкций.",
        "Определить и сохранить действительно качественные тематические ссылки (отраслевые СМИ, ассоциации, "
        "партнёры, официальные ресурсы) — они формируют авторитет.",
        "Наращивать ссылки белыми методами: экспертный контент и исследования, гостевые статьи в отраслевых "
        "СМИ, публикации в профильных каталогах и ассоциациях, PR и новости компании, партнёрские программы.",
        "Использовать локальные и брендовые площадки: Яндекс.Бизнес, 2ГИС, Google Business Profile, "
        "карточки компаний, отраслевые маркетплейсы.",
        "Работать с инфополем и соцсетями (упоминания бренда, digital-PR), запускать ссылки на профильных "
        "форумах и в отраслевых сообществах естественным образом.",
        "Регулярно отслеживать новые упоминания и динамику (Яндекс.Вебмастер, GSC, алерты) — "
        "для этого позже подключить Вебмастер/экспорт (--backlinks).",
        "Лист «Внешние ссылки» в «Контент_<хост>.xlsx» — рабочий: по нему вести чистку и работу с донорами.",
    ]

    examples = []
    for r in sorted(rows, key=lambda x: x["score"]):
        examples.append({"domain": r["domain"],
                         "verified": "да" if r["verified"] else ("нет" if r["verified"] is False else "?"),
                         "score": r["score"], "cls": r["cls"], "reasons": "; ".join(r["reasons"])[:100]})
    examples = examples[:15]

    # xlsx
    xlsx = os.path.join(args.out_dir, f"Контент_{host}.xlsx")
    wb = load_workbook(xlsx) if os.path.exists(xlsx) else Workbook()
    if not os.path.exists(xlsx):
        wb.remove(wb.active)
    sheet_rows = []
    for i, r in enumerate(sorted(rows, key=lambda x: -x["score"]), 1):
        sheet_rows.append([i, r["domain"], ("да" if r["verified"] else "нет"), r["tld"],
                           ("да" if r["relevance"] else "нет"), r["out_links"],
                           (r["nofollow"] or "—"), (r["anchor"] or "—")[:60], r["score"], r["cls"],
                           "; ".join(r["reasons"])])
    write_sheet(wb, "Внешние ссылки",
                ["№", "Домен-донор", "Ссылается обратно", "TLD", "Тематический", "Внешних ссылок на доноре",
                 "rel", "Анкор (с нашей страницы)", "Оценка", "Класс", "Комментарий"],
                sheet_rows, [5, 30, 16, 8, 13, 22, 10, 40, 8, 12, 50])
    wb.save(xlsx)

    month_ru = {"January": "Январь", "February": "Февраль", "March": "Март", "April": "Апрель",
                "May": "Май", "June": "Июнь", "July": "Июль", "August": "Август", "September": "Сентябрь",
                "October": "Октябрь", "November": "Ноябрь", "December": "Декабрь"}.get(
        datetime.now().strftime("%B"), datetime.now().strftime("%B"))
    summary = {"host": host, "month": f"{month_ru} {datetime.now().year}", "problems": problems,
               "recommendations": recommendations, "examples": examples, "source_note": source_note}
    print("[3/3] Сохранение результатов")
    build_docx(os.path.join(args.out_dir, "Внешние ссылки.docx"), base, summary)
    print("Готово:")
    print("  -", os.path.join(args.out_dir, "Внешние ссылки.docx"))
    print("  -", xlsx, "(лист «Внешние ссылки»)")
    print(f"  доноров: {total}, подтверждено обратных: {confirmed}, хороших: {good}, мусорных: {trash}")


if __name__ == "__main__":
    main()
