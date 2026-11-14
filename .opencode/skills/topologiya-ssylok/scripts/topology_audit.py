#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Пункт 1.5 «Внутренняя ссылочная топология» (технический SEO-аудит, методология «Текарт»).

Анализирует внутреннюю перелинковку сайта:
- глубина страниц от главной (количество кликов);
- входящие/исходящие ссылки по каждой странице;
- «сироты» — страницы без входящих ссылок;
- «полусироты» — страницы с 1–3 входящими ссылками;
- сквозные (шаблонные) и контекстные ссылки;
- хлебные крошки, навигация внутри раздела, дублирование меню;
- логотип на главную, HTML-карта сайта.

Запуск:
  python3 topology_audit.py --url https://example.com/ --out-dir <путь>
  python3 topology_audit.py --url https://example.com/ --out-dir <путь> --in-json <путь к site_collect JSON>
"""

import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlparse, urlunparse

try:
    from docx import Document
    from docx.shared import Pt, RGBColor
except ImportError:
    sys.exit("Нужен python-docx: pip3 install --break-system-packages python-docx")

try:
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit("Нужен beautifulsoup4: pip3 install --break-system-packages requests beautifulsoup4")

UA = {"User-Agent": "Mozilla/5.0 (compatible; SEO-audit/1.0)"}
GENERIC_TITLES = {"компания", "главная", "сайт", "главная страница", "home", "index", "официальный сайт", ""}


def norm(u):
    """Нормализует URL: убирает fragment и trailing slash."""
    u, _ = urljoin(u, "")  # normalize
    p = urlparse(u)
    path = p.path or "/"
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")
    return urlunparse((p.scheme, p.netloc, path, "", p.query, ""))


def host_matches(u, host):
    h = urlparse(u).netloc.lower()
    base = host.replace("www.", "")
    return h in (base, "www." + base, host, host.replace("www.", ""))


def is_internal(u, host):
    return host_matches(u, host)


def collect_pages_json(url, out_dir, cache_dir=None):
    """Запускает site_collect.py и возвращает JSON со списком страниц и ссылками."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_json = out_dir / "site_collect.json"

    cmd = [
        sys.executable,
        str(Path(__file__).resolve().parents[3] / "tools" / "seo_collect" / "site_collect.py"),
        "--url", url,
        "--out", str(out_json),
    ]
    if cache_dir:
        cmd.extend(["--cache", cache_dir])

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        print(f"[!] site_collect.py завершился с ошибкой: {result.stderr[:500]}")
        return None

    try:
        with open(out_json, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"[!] Не удалось прочитать {out_json}: {e}")
        return None

    return data


def classify_section(url, host):
    """Простая классификация раздела по пути URL."""
    p = urlparse(url)
    path = (p.path or "/").lower()
    if path in ("", "/"):
        return "Главная"
    if path.endswith(("/index.htm", "/index.html")):
        return "Главная (тех. дубль)"
    parts = [seg for seg in path.split("/") if seg]
    if len(parts) >= 1:
        return parts[0].capitalize()
    return "Прочее"


def has_breadcrumbs(soup):
    """Проверяет наличие хлебных крошек по типичным селекторам."""
    selectors = [
        '[class*="breadcrumb"]', '[class*="bread-crumb"]', '[class*="breadcrumbs"]',
        '[class*="nav-chain"]', '[itemprop="breadcrumb"]',
        'nav[aria-label*="хлебн" i]', 'nav[aria-label*="breadcrumb" i]',
    ]
    for sel in selectors:
        if soup.select_one(sel):
            return True
    # also look for text "хлебные крошки" or "Breadcrumbs"
    text = soup.get_text(" ", strip=True).lower()
    if "хлебные крошки" in text or "breadcrumbs" in text:
        return True
    return False


def extract_breadcrumbs(soup):
    """Извлекает список ссылок из хлебных крошек."""
    crumbs = []
    selectors = [
        '[class*="breadcrumb"] a', '[class*="bread-crumb"] a', '[class*="breadcrumbs"] a',
        '[itemprop="breadcrumb"] a',
    ]
    for sel in selectors:
        for a in soup.select(sel):
            href = a.get("href")
            text = a.get_text(" ", strip=True)
            if href and text:
                crumbs.append((text, href))
    return crumbs


def extract_footer_links(soup):
    """Извлекает ссылки из футера."""
    footer = soup.find("footer")
    if not footer:
        # try common footer classes
        footer = soup.select_one('[class*="footer"]')
    if not footer:
        return []
    links = []
    for a in footer.find_all("a", href=True):
        text = a.get_text(" ", strip=True)
        href = a["href"]
        if text or href:
            links.append((text, href))
    return links


def extract_logo_link(soup):
    """Ищет ссылку логотипа (обычно ведущую на главную)."""
    # look for logo class or img with alt containing 'logo'
    for sel in ['a[class*="logo"]', 'a.logo', 'a[href][class*="brand"]']:
        a = soup.select_one(sel)
        if a and a.get("href"):
            return a["href"].strip()
    # fallback: first link wrapping an img with 'logo' in alt
    for a in soup.find_all("a", href=True):
        img = a.find("img", alt=True)
        if img and "logo" in img.get("alt", "").lower():
            return a["href"].strip()
    return ""


def analyse_topology(pages, host):
    """Основной анализ внутренней ссылочной топологии."""
    # Build URL set
    page_urls = set()
    for p in pages:
        page_urls.add(norm(p["url"]))

    # Build link graph
    outgoing = defaultdict(set)  # url -> set of linked urls
    incoming = defaultdict(set)  # url -> set of linking urls

    for p in pages:
        u = norm(p["url"])
        for link in p.get("links_internal", []):
            lu = norm(link)
            if lu in page_urls and lu != u:
                outgoing[u].add(lu)
                incoming[lu].add(u)

    # Calculate depth from homepage using BFS
    home = norm(f"https://{host}/")
    if home not in page_urls:
        # try to find closest to root
        candidates = [u for u in page_urls if urlparse(u).path in ("", "/")]
        home = candidates[0] if candidates else sorted(page_urls)[0]

    depth = {home: 0}
    queue = [home]
    visited = {home}
    while queue:
        current = queue.pop(0)
        for neighbor in outgoing.get(current, set()):
            if neighbor not in visited:
                visited.add(neighbor)
                depth[neighbor] = depth[current] + 1
                queue.append(neighbor)

    # Pages not reached by BFS are orphan (no path from home)
    unreached = page_urls - visited
    for u in unreached:
        depth[u] = None  # unreachable

    # Orphan pages: no incoming links at all
    orphans = []
    for p in pages:
        u = norm(p["url"])
        if len(incoming.get(u, set())) == 0:
            orphans.append({
                "url": p["url"],
                "title": p.get("title", "") or "",
                "depth": depth.get(u),
                "section": classify_section(p["url"], host),
            })

    # Weak internal links: 1-3 incoming links (excluding self)
    weak = []
    for p in pages:
        u = norm(p["url"])
        inc_count = len(incoming.get(u, set()))
        if 1 <= inc_count <= 3:
            weak.append({
                "url": p["url"],
                "title": p.get("title", "") or "",
                "incoming_count": inc_count,
                "depth": depth.get(u),
                "sources": sorted([x for x in incoming.get(u, set()) if x != u])[:5],
                "section": classify_section(p["url"], host),
            })

    # Deep pages: depth > 4 from homepage
    deep = []
    for p in pages:
        u = norm(p["url"])
        d = depth.get(u)
        if d is not None and d > 4:
            deep.append({
                "url": p["url"],
                "title": p.get("title", "") or "",
                "depth": d,
                "section": classify_section(p["url"], host),
            })

    # Template vs contextual links: a link is "template" if it appears on >50% of pages
    link_page_count = Counter()
    for p in pages:
        u = norm(p["url"])
        seen = set()
        for link in p.get("links_internal", []):
            lu = norm(link)
            if lu != u and lu in page_urls:
                seen.add(lu)
        for lu in seen:
            link_page_count[lu] += 1

    template_links = {u for u, c in link_page_count.items() if c / max(len(pages), 1) > 0.5}
    contextual_links = {u for u, c in link_page_count.items() if 0 < c / max(len(pages), 1) <= 0.5}

    # Pages with only template links (no contextual incoming)
    only_template = []
    for p in pages:
        u = norm(p["url"])
        inc = incoming.get(u, set())
        contextual_inc = inc & contextual_links
        if inc and not contextual_inc:
            only_template.append({
                "url": p["url"],
                "title": p.get("title", "") or "",
                "incoming_count": len(inc),
                "section": classify_section(p["url"], host),
            })

    # Breadcrumb analysis
    breadcrumb_missing = []
    breadcrumb_self = []
    for p in pages:
        u = norm(p["url"])
        soup = p.get("_soup")
        if not soup:
            continue
        crumbs = extract_breadcrumbs(soup)
        if not crumbs:
            breadcrumb_missing.append(p["url"])
        else:
            # check if last crumb is self-link
            if crumbs:
                last_text, last_href = crumbs[-1]
                if norm(last_href) == u:
                    breadcrumb_self.append(p["url"])

    # Footer analysis
    footer_missing = []
    footer_overloaded = []
    for p in pages:
        u = norm(p["url"])
        soup = p.get("_soup")
        if not soup:
            continue
        footer_links = extract_footer_links(soup)
        if not footer_links:
            footer_missing.append(p["url"])
        elif len(footer_links) > 20:
            footer_overloaded.append({
                "url": p["url"],
                "title": p.get("title", "") or "",
                "count": len(footer_links),
            })

    # Logo analysis
    logo_issues = []
    for p in pages:
        u = norm(p["url"])
        soup = p.get("_soup")
        if not soup:
            continue
        logo_href = extract_logo_link(soup)
        if not logo_href:
            logo_issues.append({
                "url": p["url"],
                "title": p.get("title", "") or "",
                "issue": "нет ссылки логотипа",
            })
        elif norm(logo_href) not in (norm(f"https://{host}/"), norm(f"https://www.{host}/")):
            logo_issues.append({
                "url": p["url"],
                "title": p.get("title", "") or "",
                "issue": f"логотип ведёт на {logo_href}, а не на главную",
            })

    # HTML sitemap check
    sitemap_html_found = False
    sitemap_html_url = ""
    for p in pages:
        title = (p.get("title") or "").lower()
        url_lower = p["url"].lower()
        if "sitemap" in title or "sitemap" in url_lower or "карта сайта" in title:
            sitemap_html_found = True
            sitemap_html_url = p["url"]
            break

    # Thematic connectivity: pages linking to unrelated sections
    thematic_issues = []
    for p in pages:
        u = norm(p["url"])
        p_section = classify_section(p["url"], host)
        for link in p.get("links_internal", []):
            lu = norm(link)
            if lu == u or lu not in page_urls:
                continue
            lp = next((pp for pp in pages if norm(pp["url"]) == lu), None)
            if lp:
                l_section = classify_section(lp["url"], host)
                if p_section not in ("Главная", "Главная (тех. дубль)", "Прочее") and \
                   l_section not in ("Главная", "Главная (тех. дубль)", "Прочее") and \
                   p_section != l_section:
                    # cross-section link - check if it's contextual (not template)
                    if lu not in template_links:
                        thematic_issues.append({
                            "from": p["url"],
                            "to": lp["url"],
                            "from_section": p_section,
                            "to_section": l_section,
                        })

    return {
        "home": home,
        "total_pages": len(pages),
        "pages_with_links": len([p for p in pages if p.get("links_internal")]),
        "total_internal_links": sum(len(p.get("links_internal", [])) for p in pages),
        "depth": depth,
        "orphans": orphans,
        "weak": weak,
        "deep": deep,
        "template_links_count": len(template_links),
        "contextual_links_count": len(contextual_links),
        "only_template_links": only_template,
        "breadcrumb_missing": breadcrumb_missing,
        "breadcrumb_self": breadcrumb_self,
        "footer_missing": footer_missing,
        "footer_overloaded": footer_overloaded,
        "logo_issues": logo_issues,
        "sitemap_html_found": sitemap_html_found,
        "sitemap_html_url": sitemap_html_url,
        "thematic_issues": thematic_issues[:20],
    }


def set_font(run, size, color=None):
    run.font.size = Pt(size)
    if color is not None:
        run.font.color.rgb = RGBColor.from_string(color)


def build_docx(path, base, summary):
    doc = Document()
    doc.styles["Normal"].font.size = Pt(10)
    doc.styles["Normal"].font.name = "Calibri"

    # Title page
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
    doc.add_paragraph()
    doc.add_paragraph()

    doc.add_heading("Анализ страничных факторов", level=1)
    doc.add_heading("1.5. Внутренняя ссылочная топология", level=2)

    doc.add_paragraph(
        "Внутренняя ссылочная топология — это структура ссылок между страницами сайта. "
        "Она определяет, как поисковый робот обходит сайт, как распределяется ссылочный вес "
        "между страницами и какие страницы поисковая система считает наиболее важными. "
        "Логичная иерархия разделов, сквозная навигация, полные хлебные крошки и "
        "контекстные перелинковки помогают роботам быстрее находить и индексировать "
        "страницы, понимать тематические связи разделов и передавать вес на приоритетные "
        "страницы, а посетителям — легко перемещаться по сайту. Напротив, плоская или "
        "запутанная структура, «страницы-сироты» и слабая перелинковка приводят к тому, "
        "что важные страницы недополучают вес, медленнее индексируются и хуже ранжируются."
    )

    p = doc.add_paragraph()
    p.add_run("В ходе проверки выявлены следующие проблемы:").bold = True
    for b in summary.get("problems", []):
        doc.add_paragraph(b, style="List Bullet")

    p = doc.add_paragraph()
    r = p.add_run("Рекомендация: ")
    r.bold = True
    p.add_run("привести внутреннюю перелинковку к единым правилам:")
    for b in summary.get("recommendations", []):
        doc.add_paragraph(b, style="List Bullet")

    if summary.get("examples"):
        doc.add_paragraph()
        cap = doc.add_paragraph()
        cap.add_run("Таблица 1. Примеры страниц с проблемами внутренней перелинковки").bold = True
        tbl = doc.add_table(rows=1, cols=4)
        tbl.style = "Table Grid"
        for i, h in enumerate(["Страница", "Проблема", "Подробности", "Рекомендация"]):
            c = tbl.rows[0].cells[i]
            c.text = h
            for par in c.paragraphs:
                for run in par.runs:
                    run.bold = True
        for e in summary["examples"]:
            cells = tbl.add_row().cells
            cells[0].text = e.get("url", "")
            cells[1].text = e.get("problem", "")
            cells[2].text = e.get("detail", "")
            cells[3].text = e.get("fix", "")

    if summary.get("positive"):
        doc.add_paragraph()
        cap = doc.add_paragraph()
        cap.add_run("Положительное").bold = True
        for b in summary["positive"]:
            doc.add_paragraph(b, style="List Bullet")

    doc.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--in-json", default="", help="путь к JSON сайт_коллектора (если уже собран)")
    ap.add_argument("--cache", default="", help="каталог HTTP-кэша")
    args = ap.parse_args()

    base = args.url if args.url.endswith("/") else args.url + "/"
    host = urlparse(base).netloc
    os.makedirs(args.out_dir, exist_ok=True)

    # Collect pages
    if args.in_json and os.path.exists(args.in_json):
        print(f"[1/3] Загрузка данных из {args.in_json}")
        with open(args.in_json, encoding="utf-8") as f:
            data = json.load(f)
    else:
        print(f"[1/3] Сбор URL и ссылок: {base}")
        data = collect_pages_json(base, args.out_dir, cache_dir=args.cache)
        if not data:
            print("Не удалось собрать данные сайта")
            return 1

    pages = data.get("pages", [])
    print(f"      найдено URL: {len(pages)}")

    # Attach BeautifulSoup objects for breadcrumb/footer/logo analysis if HTML stored
    for p in pages:
        p["_soup"] = None  # site_collect doesn't store HTML, we work with links only

    result = analyse_topology(pages, host)

    # Build problems list
    problems = []
    if result["orphans"]:
        problems.append(
            f"Страницы-сироты (без входящих ссылок): {len(result['orphans'])} стр. "
            f"(например: {', '.join(o['url'] for o in result['orphans'][:3])})"
        )
    if result["weak"]:
        problems.append(
            f"Слабая внутренняя перелинковка (1–3 входящих ссылки): {len(result['weak'])} стр."
        )
    if result["deep"]:
        problems.append(
            f"Глубокая вложенность (более 4 кликов от главной): {len(result['deep'])} стр."
        )
    if result["breadcrumb_missing"]:
        problems.append(
            f"Отсутствуют хлебные крошки: {len(result['breadcrumb_missing'])} стр."
        )
    if result["breadcrumb_self"]:
        problems.append(
            f"Хлебные крошки ведут на текущую страницу (self-ссылка): {len(result['breadcrumb_self'])} стр."
        )
    if result["footer_missing"]:
        problems.append(
            f"Отсутствует футер с навигацией: {len(result['footer_missing'])} стр."
        )
    if result["footer_overloaded"]:
        problems.append(
            f"Перегруженный футер (>20 ссылок): {len(result['footer_overloaded'])} стр."
        )
    if result["logo_issues"]:
        problems.append(
            f"Проблемы со ссылкой логотипа: {len(result['logo_issues'])} стр."
        )
    if not result["sitemap_html_found"]:
        problems.append("HTML-карта сайта не найдена")

    if not problems:
        problems = ["Проблем на сайте не обнаружено, исправления не требуются."]

    # Recommendations
    recommendations = [
        "Добавить внутренние ссылки на страницы-сироты из тематических разделов.",
        "Усилить перелинковку страниц с 1–3 входящими ссылками контекстными ссылками из близких разделов.",
        "Уменьшить вложенность 깊ьных страниц (более 4 кликов от главной) через добавление ссылок с главной или разделов верхнего уровня.",
        "Добавить полные хлебные крошки на все страницы, кроме главной (последний элемент — без ссылки).",
        "Проверить, что логотип ведёт на канонический адрес главной (/), а не на технический дубль.",
        "Добавить навигацию внутри раздела (боковое меню или блок «Смотрите также»).",
        "Создать HTML-карту сайта со всеми разделами и подразделами, поддерживать её в актуальном состоянии.",
    ]

    # Examples for docx table
    examples = []
    for o in result["orphans"][:5]:
        examples.append({
            "url": o["url"],
            "problem": "Страница-сирота (нет входящих ссылок)",
            "detail": f"Глубина: {o['depth'] if o['depth'] is not None else 'неизвестна'}",
            "fix": "Добавить ссылку из соответствующего раздела",
        })
    for w in result["weak"][:5]:
        examples.append({
            "url": w["url"],
            "problem": "Слабая перелинковка",
            "detail": f"Входящих ссылок: {w['incoming_count']}, глубина: {w['depth']}",
            "fix": "Добавить контекстные ссылки из тематических страниц",
        })
    for d in result["deep"][:5]:
        examples.append({
            "url": d["url"],
            "problem": "Глубокая вложенность",
            "detail": f"Глубина: {d['depth']} кликов от главной",
            "fix": "Добавить ссылку с главной или раздела верхнего уровня",
        })
    for b in result["breadcrumb_missing"][:3]:
        examples.append({
            "url": b,
            "problem": "Отсутствуют хлебные крошки",
            "detail": "Страница без навигационной цепочки",
            "fix": "Добавить хлебные крошки со ссылками на родительские разделы",
        })
    for b in result["breadcrumb_self"][:3]:
        examples.append({
            "url": b,
            "problem": "Хлебные крошки ведут на текущую страницу",
            "detail": "Self-ссылка в хлебных крошках",
            "fix": "Убрать ссылку на текущую страницу из хлебных крошек",
        })

    summary = {
        "host": host,
        "month": datetime.now().strftime("%B %Y"),
        "problems": problems,
        "recommendations": recommendations,
        "examples": examples,
        "positive": [],
    }

    # Add positive findings
    if result["sitemap_html_found"]:
        summary["positive"].append(f"HTML-карта сайта найдена: {result['sitemap_html_url']}")
    if result["template_links_count"] > 0:
        summary["positive"].append(
            f"Найдено {result['template_links_count']} сквозных (шаблонных) ссылок — стабильная навигация"
        )
    if result["contextual_links_count"] > 0:
        summary["positive"].append(
            f"Найдено {result['contextual_links_count']} контекстных ссылок — тематическая перелинковка присутствует"
        )

    print("[2/3] Анализ внутренней ссылочной топологии завершён")
    print(f"      Страниц: {result['total_pages']}, ссылок: {result['total_internal_links']}")
    print(f"      Сирот: {len(result['orphans'])}, слабая перелинковка: {len(result['weak'])}")
    print(f"      Глубокая вложенность: {len(result['deep'])}")
    print(f"      Хлебных крошек нет: {len(result['breadcrumb_missing'])}")

    # Save results to JSON for potential reuse
    result_json = {k: v for k, v in result.items() if k != "depth"}  # depth is not JSON serializable easily
    result_json["depth_count"] = {str(k): v for k, v in Counter(result["depth"].values()).items()}
    with open(os.path.join(args.out_dir, "topology.json"), "w", encoding="utf-8") as f:
        json.dump(result_json, f, ensure_ascii=False, indent=2)

    print("[3/3] Генерация отчёта .docx")
    build_docx(os.path.join(args.out_dir, "Внутренняя ссылочная топология.docx"), base, summary)
    print("Готово:")
    print("  -", os.path.join(args.out_dir, "Внутренняя ссылочная топология.docx"))
    print("  -", os.path.join(args.out_dir, "topology.json"))


if __name__ == "__main__":
    sys.exit(main())
