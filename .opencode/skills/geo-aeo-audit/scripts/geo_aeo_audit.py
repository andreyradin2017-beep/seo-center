#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Пункт 5.1 «GEO/AEO аудит» — готовность сайта к ИИ-поисковикам
(Digital/Generative Engine Optimization, Answer Engine Optimization).

Проверяет и формирует раздел в итоговом .docx (методология «Текарт»):
  - доступность для ИИ-краулеров (GPTBot, Google-Extended, ClaudeBot,
    PerplexityBot, anthropic-ai, cohere-ai, AI2 и др.) в robots.txt;
  - наличие и корректность llms.txt в корне сайта;
  - структурированные данные (JSON-LD/Microdata) — Article, Organization,
    LocalBusiness, BreadcrumbList, FAQPage, Product и др.;
  - OpenGraph (og:title, og:description, og:image, og:url, og:type);
  - рабочий https, rel=canonical, читаемые URL (без лишних параметров).

Данные берёт из общего коллектора site_collect.py (один обход -> JSON), либо
обходит сайт через него. Служебные файлы (/robots.txt, /llms.txt) проверяет
дополнительно напрямую.

Запуск:
  python3 geo_aeo_audit.py --url https://example.com/ --out-dir <путь>
  python3 geo_aeo_audit.py --url https://example.com/ --out-dir <путь> --in-json <site_collect.json>
"""

import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlparse, urlunparse

try:
    from docx import Document
    from docx.shared import Pt, RGBColor
except ImportError:
    sys.exit("Нужен python-docx: pip3 install --break-system-packages python-docx")

try:
    import requests
except ImportError:
    sys.exit("Нужен requests: pip3 install --break-system-packages requests")

UA = {"User-Agent": "Mozilla/5.0 (compatible; SEO-audit/1.0)"}


def load_audit_rules():
    """Машиночитаемые правила GEO-аудита из .opencode/rules/audit-rules.json."""
    rules_path = Path(__file__).resolve().parents[3] / "rules" / "audit-rules.json"
    try:
        with open(rules_path, encoding="utf-8") as f:
            data = json.load(f)
        return data.get("geo_aeo", data.get("geoaеo", {}))
    except Exception:
        return {}


_RULES = load_audit_rules()
AI_CRAWLERS = _RULES.get("ai_crawlers", [
    "GPTBot", "Google-Extended", "ClaudeBot", "PerplexityBot",
    "anthropic-ai", "cohere-ai", "AI2", "facebookexternalhit", "twitterbot",
])
REQUIRED_JSONLD = _RULES.get("required_jsonld_types", [
    "Article", "NewsArticle", "BlogPosting", "Organization", "LocalBusiness",
    "BreadcrumbList", "FAQPage", "Product",
])
REQUIRED_OG = _RULES.get("required_opengraph", [
    "og:title", "og:description", "og:image", "og:url", "og:type",
])
REMOVE_PARAM_HINTS = ["PAGEN_", "PAGEN", "page=", "&page", "?"]


def norm(u):
    p = urlparse(u)
    path = p.path or "/"
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")
    return urlunparse((p.scheme, p.netloc, path, "", p.query, ""))


def is_internal_ai_block(text, agent):
    """Ищет секцию User-agent: <agent> и возвращает True, если она Disallow всё."""
    if not text:
        return False
    lines = [ln.strip() for ln in text.splitlines()]
    in_sec = False
    for ln in lines:
        low = ln.lower()
        if low.startswith("user-agent:"):
            val = low.split(":", 1)[1].strip()
            in_sec = val == agent.lower() or val == "*"
            continue
        if in_sec and low.startswith("disallow:"):
            val = ln.split(":", 1)[1].strip()
            if val == "/":
                return True
        if in_sec and low.startswith(("allow:", "sitemap:", "crawl-delay:")):
            continue
    return False


def analyse_robots(robots_text):
    """Проверка блокировки ИИ-краулеров в robots.txt."""
    blocked = []
    allowed = []
    for agent in AI_CRAWLERS:
        if is_internal_ai_block(robots_text, agent):
            blocked.append(agent)
        else:
            allowed.append(agent)
    return {"blocked": blocked, "allowed": allowed, "checked": AI_CRAWLERS}


def fetch_llms_txt(base):
    """Загружает llms.txt из корня сайта. Возвращает (code, text)."""
    for variant in ("/llms.txt", "/llms.txt/"):
        try:
            r = requests.get(urljoin(base, variant), headers=UA, timeout=20)
            if r.status_code == 200 and "text" in (r.headers.get("Content-Type", "") or "").lower():
                return r.status_code, r.text
        except Exception:
            continue
    return 0, ""


def analyse_llms_txt(code, text):
    """Оценка файла llms.txt: наличие, заголовок, базовые разделы, битые ссылки."""
    if code != 200 or not text.strip():
        return {
            "found": False, "issues": ["Файл llms.txt отсутствует или недоступен в корне сайта."],
            "recommendation": "Создать llms.txt в корне: краткое описание компании, разделы H1–H2 «# <Компания>» / «## Раздел», список ключевых URL (по одному на строку, с коротким анкором).",
        }
    issues = []
    lines = text.splitlines()
    has_title = any(ln.startswith("# ") for ln in lines)
    has_sections = any(ln.startswith("## ") for ln in lines)
    broken = []
    for ln in lines:
        m = re.match(r"^\s*\[([^\]]*)\]\((https?://[^)\s]+)\)", ln)
        if m:
            url = m.group(2)
            try:
                r = requests.get(url, headers=UA, timeout=15, allow_redirects=True)
                if r.status_code >= 400:
                    broken.append((url, r.status_code))
            except Exception:
                broken.append((url, 0))
    if not has_title:
        issues.append("Нет заголовка # (краткое описание компании) в llms.txt.")
    if not has_sections:
        issues.append("Нет разделов ## (разделы сайта) в llms.txt — структура не раскрыта.")
    if broken:
        issues.append(f"Битые ссылки в llms.txt: {len(broken)} (например: {'; '.join(f'{u} → {c}' for u, c in broken[:3])}).")
    if not issues:
        issues = []
    return {
        "found": True,
        "lines": len(lines),
        "broken_count": len(broken),
        "issues": issues,
        "recommendation": "Держать llms.txt актуальным: до 100–200 ссылок на ключевые страницы, разделы по направлениям, корректные URL.",
    }


def collect_json(url, out_dir, in_json):
    """Запускает общий коллектор site_collect.py и возвращает данные."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_json = out_dir / "site_collect.json"

    if in_json and os.path.exists(in_json):
        with open(in_json, encoding="utf-8") as f:
            return json.load(f)

    cmd = [
        sys.executable,
        str(Path(__file__).resolve().parents[3] / "tools" / "seo_collect" / "site_collect.py"),
        "--url", url,
        "--out", str(out_json),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        print(f"[!] site_collect.py: {result.stderr[:500]}")
        return None
    try:
        with open(out_json, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[!] Не прочитать {out_json}: {e}")
        return None


def url_readable(u):
    """Читаемость URL: латиница, без лишних параметров, без повторных слэшей."""
    issues = []
    p = urlparse(u)
    path = (p.path or "").lower()
    if re.search(r"[а-яё]", path):
        issues.append("кириллица в пути")
    if p.query:
        issues.append("параметры в URL")
    if "//" in path.replace("://", ""):
        issues.append("двойной слеш")
    return issues


def analyse_site(data, host):
    """Основной GEO/AEO анализ по данным коллектора."""
    pages = data.get("pages", [])
    robots = data.get("robots", {})
    robots_text = robots.get("text", "")

    # 1. ИИ-краулеры в robots.txt
    robots_res = analyse_robots(robots_text)

    # 2. llms.txt
    llms = {"found": False, "issues": [], "recommendation": ""}

    # 3. Структурированные данные и OpenGraph по страницам
    jsonld_present = {}
    micro_present = {}
    og_present = {}
    for p in pages:
        for t in p.get("jsonld_types", []):
            jsonld_present[t] = jsonld_present.get(t, 0) + 1
        for t in p.get("microdata_types", []):
            tnorm = t.split("/")[-1] or t
            micro_present[tnorm] = micro_present.get(tnorm, 0) + 1
        for k in p.get("og", {}):
            og_present[k] = og_present.get(k, 0) + 1

    missing_jsonld = [t for t in REQUIRED_JSONLD if t not in jsonld_present and t not in micro_present]
    missing_og = [k for k in REQUIRED_OG if k not in og_present]

    # 4. HTTPS и canonical
    http_pages = [p["url"] for p in pages if p["url"].startswith("http://")]
    no_canonical = [p["url"] for p in pages if not p.get("canonical")]
    canon_mismatch = []
    for p in pages:
        c = p.get("canonical") or ""
        if c and norm(c) != norm(p["url"]):
            canon_mismatch.append(p["url"])

    # 5. Читаемость URL
    unreadable = []
    examples = {"structure": [], "canonical": [], "robots": [], "og": [], "https": [], "url": []}
    for p in pages:
        issues = url_readable(p["url"])
        if issues:
            unreadable.append({"url": p["url"], "issues": issues})
        if len(examples["url"]) < 5 and issues:
            examples["url"].append(p["url"])
    if not pages:
        examples["structure"] = ["Нет страниц — проверьте сбор данных."]

    return {
        "host": host,
        "total_pages": len(pages),
        "robots": robots_res,
        "llms": llms,
        "jsonld_present": jsonld_present,
        "microdata_present": micro_present,
        "missing_jsonld": missing_jsonld,
        "og_present": og_present,
        "missing_og": missing_og,
        "http_pages_count": len(http_pages),
        "no_canonical_count": len(no_canonical),
        "canon_mismatch_count": len(canon_mismatch),
        "unreadable_urls": unreadable,
        "unreadable_count": len(unreadable),
    }


def set_font(run, size, color=None):
    run.font.size = Pt(size)
    if color is not None:
        run.font.color.rgb = color


def build_docx(path, base, summary):
    doc = Document()
    doc.styles["Normal"].font.size = Pt(10)
    doc.styles["Normal"].font.name = "Calibri"

    # Обложка
    doc.add_paragraph()
    t = doc.add_paragraph()
    r = t.add_run(f"Технический аудит сайта {base}")
    set_font(r, 24, RGBColor(0x33, 0x33, 0x33))
    d = doc.add_paragraph()
    rr = d.add_run(summary.get("month", datetime.now().strftime("%B %Y")))
    set_font(rr, 9, RGBColor(0x94, 0x29, 0x72))
    doc.add_paragraph()
    toc = doc.add_paragraph()
    tr = toc.add_run("Содержание")
    set_font(tr, 20, RGBColor(0x33, 0x33, 0x33))
    doc.add_paragraph()

    doc.add_heading("Анализ страничных факторов", level=1)
    doc.add_heading("5.1. GEO/AEO аудит (готовность к ИИ-поиску)", level=2)

    doc.add_paragraph(
        "GEO (Optimization for Generative Engines) и AEO (Answer Engine Optimization) — "
        "оптимизация сайта под ИИ-поисковики и ассистентов: ChatGPT, Claude, Perplexity, "
        "Яндекс Алиса и др. Цель — чтобы нейросеть цитировала сайт как источник в ответах. "
        "Для этого важны доступность сайта для ИИ-краулеров, файл llms.txt, структурированные "
        "данные, корректные OpenGraph и адресация."
    )

    r = doc.add_paragraph()
    r.add_run(f"Проверено страниц: {summary['total_pages']}.").bold = True

    p = doc.add_paragraph()
    p.add_run("Выявленные проблемы:").bold = True
    for b in summary.get("problems", []):
        doc.add_paragraph(b, style="List Bullet")

    p = doc.add_paragraph()
    r = p.add_run("Рекомендация: ")
    r.bold = True
    p.add_run("привести сайт к следующим правилам:")
    for b in summary.get("recommendations", []):
        doc.add_paragraph(b, style="List Bullet")

    # Таблица примеров
    if summary.get("examples"):
        cap = doc.add_paragraph()
        cap.add_run("Таблица 1. Примеры выявленных проблем").bold = True
        tbl = doc.add_table(rows=1, cols=3)
        tbl.style = "Table Grid"
        for i, h in enumerate(["URL", "Проблема", "Рекомендация"]):
            c = tbl.rows[0].cells[i]
            c.text = h
            for par in c.paragraphs:
                for run in par.runs:
                    run.bold = True
        for e in summary["examples"]:
            cells = tbl.add_row().cells
            cells[0].text = e.get("url", "")
            cells[1].text = e.get("problem", "")
            cells[2].text = e.get("fix", "")

    if summary.get("positive"):
        cap = doc.add_paragraph()
        cap.add_run("Положительное").bold = True
        for b in summary["positive"]:
            doc.add_paragraph(b, style="List Bullet")

    doc.save(path)


def main():
    ap = argparse.ArgumentParser(description="Пункт 5.1 — GEO/AEO аудит")
    ap.add_argument("--url", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--in-json", default="", help="путь к JSON сайт_коллектора")
    ap.add_argument("--cache", default="", help="каталог HTTP-кэша")
    args = ap.parse_args()

    base = args.url if args.url.endswith("/") else args.url + "/"
    host = urlparse(base).netloc
    os.makedirs(args.out_dir, exist_ok=True)

    print("[1/3] Сбор данных")
    data = collect_json(base, args.out_dir, args.in_json)
    if not data:
        print("Не удалось собрать данные сайта")
        return 1

    # llms.txt проверяем напрямую (его нет в JSON коллектора)
    llms_code, llms_text = fetch_llms_txt(base)
    llms = analyse_llms_txt(llms_code, llms_text)

    print("[2/3] Анализ GEO/AEO")
    result = analyse_site(data, host)
    result["llms"] = llms

    pages = data.get("pages", [])
    problems = []
    recommendations = []

    # robots
    if result["robots"]["blocked"]:
        problems.append("Заблокированы ИИ-краулеры в robots.txt: " + ", ".join(result["robots"]["blocked"]) + ".")
        recommendations.append("Открыть доступ ИИ-краулерам в robots.txt (не блокировать GPTBot, Google-Extended, ClaudeBot и др. директивой Disallow: /).")
    else:
        recommendations.append("Проверить robots.txt: блокировать только служебные разделы, ИИ-краулеры не закрывать директивами Disallow: /.")

    # llms
    if llms["issues"]:
        problems.extend(llms["issues"])
    recommendations.append(llms.get("recommendation", ""))

    # structured data
    if result["missing_jsonld"]:
        problems.append("Отсутствуют типы разметки: " + ", ".join(result["missing_jsonld"]) + " (JSON-LD/Microdata).")
        recommendations.append("Добавить структурированные данные ключевых типов (Organization на «О компании», BreadcrumbList на всех страницах кроме главной, FAQPage/Article по назначению).")
    else:
        recommendations.append("Проверить, что разметка у всех типов валидна (validator.schema.org).")

    # og
    if result["missing_og"]:
        problems.append("Отсутствуют OpenGraph-теги: " + ", ".join(result["missing_og"]) + ".")
        recommendations.append("Добавить OpenGraph-теги (og:title, og:description, og:image, og:url, og:type) — их читают и ИИ-поисковики, и соцсети.")
    else:
        recommendations.append("OpenGraph-теги на месте — поддерживать актуальными.")

    # https / canonical
    if result["http_pages_count"]:
        problems.append(f"Страницы по http:// (не https): {result['http_pages_count']}.")
        recommendations.append("Перевести все страницы на https и настроить 301-редирект с http.")
    if result["no_canonical_count"]:
        problems.append(f"Страницы без rel=canonical: {result['no_canonical_count']}.")
        recommendations.append("Проставить rel=canonical на всех страницах.")
    if result["canon_mismatch_count"]:
        problems.append(f"Страницы, где canonical отличается от URL: {result['canon_mismatch_count']}.")
        recommendations.append("Согласовать canonical с адресом страницы (кроме технических клонов: пагинация, фильтры).")

    # url readability
    if result["unreadable_count"]:
        problems.append(f"Нечитаемые URL (кириллица/параметры/двойной слеш): {result['unreadable_count']} стр.")
        recommendations.append("Настроить ЧПУ (латиница, без параметров, без двойных слешей) с 301-редиректами со старых адресов.")

    # Нет проблем
    if not problems:
        problems = ["Проблем на сайте не обнаружено, исправления не требуются."]

    recommendations = [r for r in recommendations if r]

    # Примеры для таблицы
    examples = []
    if result["robots"]["blocked"]:
        examples.append({"url": "/robots.txt", "problem": "Заблокированы ИИ-краулеры: " + ", ".join(result["robots"]["blocked"]), "fix": "Убрать Disallow: / для ИИ-агентов"})
    for u in result["unreadable_urls"][:3]:
        examples.append({"url": u["url"], "problem": "; ".join(u["issues"]), "fix": "Настроить ЧПУ"})
    for p in pages[:3]:
        if not p.get("canonical"):
            examples.append({"url": p["url"], "problem": "Нет rel=canonical", "fix": "Проставить canonical"})
            break
    if llms["issues"]:
        examples.append({"url": "/llms.txt", "problem": "; ".join(llms["issues"][:2]), "fix": "Создать/исправить llms.txt"})

    # Положительные моменты
    positive = []
    if not result["robots"]["blocked"] and result["robots"]["allowed"]:
        positive.append(f"ИИ-краулеры не заблокированы: {', '.join(result['robots']['allowed'][:5])}.")
    if llms["found"]:
        positive.append(f"Файл llms.txt найден ({llms['lines']} строк).")
    jl = [t for t in REQUIRED_JSONLD if t in result["jsonld_present"] or t in result["microdata_present"]]
    if jl:
        positive.append("Найденные типы разметки: " + ", ".join(jl) + ".")
    og_ok = [k for k in REQUIRED_OG if k in result["og_present"]]
    if og_ok:
        positive.append("OpenGraph-теги на месте: " + ", ".join(og_ok) + ".")
    if not result["http_pages_count"]:
        positive.append("Сайт полностью работает по https.")

    month_ru = {"January": "Январь", "February": "Февраль", "March": "Март", "April": "Апрель",
                "May": "Май", "June": "Июнь", "July": "Июль", "August": "Август", "September": "Сентябрь",
                "October": "Октябрь", "November": "Ноябрь", "December": "Декабрь"}.get(
        datetime.now().strftime("%B"), datetime.now().strftime("%B"))

    summary = {
        "host": host,
        "month": f"{month_ru} {datetime.now().year}",
        "total_pages": result["total_pages"],
        "problems": problems,
        "recommendations": recommendations,
        "examples": examples,
        "positive": positive,
    }

    # Сохраняем JSON результата
    out_json = os.path.join(args.out_dir, "geo_aeo.json")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print("[3/3] Генерация отчёта .docx")
    build_docx(os.path.join(args.out_dir, "GEO-AEO аудит.docx"), base, summary)
    print("Готово:")
    print("  -", os.path.join(args.out_dir, "GEO-AEO аудит.docx"))
    print("  -", out_json)


if __name__ == "__main__":
    sys.exit(main())
