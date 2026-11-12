#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Общий краулер-коллектор для модельных пунктов технического SEO-аудита
(1.1 адреса, 1.2 дубликаты, 1.3 отклики сервера, 1.4 индексация, 1.5 топология,
2.6 микроразметка). Один обход сайта -> один JSON со всеми данными, которые нужны
модельным пунктам, вместо ручного сбора в каждой сессии.

Что собирает по каждой странице:
  - статус, цепочку редиректов, финальный URL, content-type;
  - title, meta description, meta robots, canonical, lang;
  - H1–H6 (список), основной текст;
  - OpenGraph / Twitter-Cards;
  - JSON-LD (типы @type) и Microdata (itemtype/itemprop);
  - внутренние и внешние ссылки (href, rel, anchor);
  - изображения (src, alt, width, height, loading);
  - признаки soft-404.

Дополнительно:
  - список URL из sitemap (и вложенных sitemap), robots.txt;
  - статусы всех внутренних ссылок (в т.ч. тех, что ведут на 3xx/4xx/5xx) — для п. 1.3.

Запуск:
  python3 .opencode/tools/seo_collect/site_collect.py --url https://pokras.ru/ \
      --out /tmp/opencode/pokras.ru_site.json

Кэш: результат сохраняется в JSON и переиспользуется (по умолчанию 2 часа),
пока не передан --refresh. Это экономит время, если несколько пунктов идут подряд.
"""
import argparse
import json
import os
import re
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from urllib.parse import urljoin, urldefrag, urlparse, urlunparse

try:
    import requests
except ImportError:
    sys.exit("Нужен requests: pip3 install --break-system-packages requests")
try:
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit("Нужен beautifulsoup4: pip3 install --break-system-packages requests beautifulsoup4")

UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
}

SKIP_EXT = re.compile(
    r"\.(?:pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|docx?|xlsx?|pptx?|zip|rar|7z|"
    r"gz|tar|mp4|mp3|avi|mov|wmv|flv|css|js|json|xml|rss|txt|csv|woff2?|ttf|eot|map)$",
    re.I,
)
SKIP_PATH_PREFIX = ("/cdn-cgi/", "/wp-json/", "/xmlrpc.php")
SOFT404_RE = re.compile(r"(страница\s+не\s+найдена|не\s+найдена|404|not\s+found|page\s+not\s+found)", re.I)


def norm(u):
    u, _ = urldefrag(u)
    return u.rstrip()


def host_matches(u, host):
    h = urlparse(u).netloc.lower()
    base = host.replace("www.", "")
    return h in (base, "www." + base, host, host.replace("www.", ""))


def is_internal(u, host):
    return host_matches(u, host)


def skip_url(u, host):
    p = urlparse(u)
    if p.scheme not in ("http", "https"):
        return True
    if p.netloc and not is_internal(u, host):
        return True
    if SKIP_EXT.search(p.path):
        return True
    low = p.path.lower()
    if any(low.startswith(pre) for pre in SKIP_PATH_PREFIX):
        return True
    if low.startswith(("/search", "/basket", "/cart", "/order", "/login", "/logout", "/admin")):
        return True
    return False


def canon(u, host):
    p = urlparse(u)
    path = p.path or "/"
    return urlunparse(("https", host, path, "", p.query, ""))


def fetch(session, url, timeout, allow_redirects=True):
    try:
        r = session.get(url, headers=UA, timeout=timeout, allow_redirects=allow_redirects)
        return r
    except Exception as e:
        return e


def sitemap_urls(session, base, host, timeout, max_depth=3):
    """Читает sitemap.xml и вложенные sitemap-индексы. Возвращает (urls, info)."""
    import xml.etree.ElementTree as ET

    found = []
    queues = [urljoin(base, "/sitemap.xml"), urljoin(base, "/sitemap_index.xml"), urljoin(base, "/sitemap/")]
    seen_sm = set()
    urls = []
    depth = 0
    while queues and depth <= max_depth:
        depth += 1
        nxt = []
        for sm in queues:
            if sm in seen_sm:
                continue
            seen_sm.add(sm)
            r = fetch(session, sm, timeout)
            if isinstance(r, Exception) or r.status_code != 200 or "<" not in r.text[:300]:
                continue
            try:
                root = ET.fromstring(r.content)
            except Exception:
                continue
            found.append(sm)
            for e in root.iter():
                if not e.tag.endswith("loc") or not e.text:
                    continue
                loc = e.text.strip()
                if not loc:
                    continue
                if not loc.lower().startswith("http"):
                    loc = urljoin(base, loc)
                loc = norm(loc)
                if loc.endswith((".xml", ".xml.gz")) or re.search(r"sitemap", loc, re.I):
                    nxt.append(loc)
                elif is_internal(loc, host):
                    urls.append(canon(loc, host))
        queues = nxt

    info = {"found": bool(found), "files": found, "urls": 0, "source": found[0] if found else ""}
    # дедуп с сохранением порядка
    dedup = list(dict.fromkeys(urls))
    info["urls"] = len(dedup)
    return dedup, info


def main_text(soup):
    for sel in ["main", "article", "#content", ".content", ".page-full-content",
                ".b-page__content-column", ".article", ".news-detail", "#content-column-left"]:
        el = soup.select_one(sel)
        if not el:
            continue
        for bad in el.select("script,style,noscript,nav,footer,header,form,svg,iframe"):
            bad.decompose()
        txt = el.get_text(" ", strip=True)
        if len(txt) > 150:
            return re.sub(r"\s+", " ", txt)
    for bad in soup(["script", "style", "noscript", "nav", "footer", "header", "form", "svg"]):
        bad.decompose()
    return re.sub(r"\s+", " ", soup.get_text(" ", strip=True))


def get_headings(soup):
    out = []
    for lvl in range(1, 7):
        for h in soup.find_all(f"h{lvl}"):
            t = re.sub(r"\s+", " ", h.get_text(" ", strip=True))
            if t:
                out.append({"level": lvl, "text": t})
    return out


def parse_jsonld(soup):
    """Возвращает (types, blocks). types — короткие @type, blocks — сырые строки."""
    types = []
    blocks = []
    for s in soup.find_all("script", type=lambda v: v and "ld+json" in v.lower()):
        raw = s.string or s.get_text() or ""
        raw = raw.strip()
        if not raw:
            continue
        blocks.append(raw)
        try:
            data = json.loads(raw)
        except Exception:
            continue

        def walk(node):
            if isinstance(node, dict):
                t = node.get("@type")
                if isinstance(t, str):
                    types.append(t)
                elif isinstance(t, list):
                    types.extend([x for x in t if isinstance(x, str)])
                for v in node.values():
                    walk(v)
            elif isinstance(node, list):
                for v in node:
                    walk(v)

        walk(data)
    return types, blocks


def parse_microdata(soup):
    types = []
    props = []
    for el in soup.select("[itemtype]"):
        it = (el.get("itemtype") or "").strip()
        if it:
            types.append(it)
    for el in soup.select("[itemprop]"):
        ip = (el.get("itemprop") or "").strip()
        if ip:
            props.append(ip)
    return types, props


def parse_meta(soup):
    og = {}
    twitter = {}
    for m in soup.find_all("meta"):
        prop = (m.get("property") or "").strip().lower()
        name = (m.get("name") or "").strip().lower()
        val = (m.get("content") or "").strip()
        if not val:
            continue
        if prop.startswith("og:"):
            og[prop] = val
        elif prop.startswith("article:") or prop.startswith("twitter:"):
            og[prop] = val
        if name.startswith("twitter:"):
            twitter[name] = val
    return og, twitter


def parse_links(soup, page_url, host):
    """Внутренние ссылки — уникальные абсолютные URL (строки), внешние — с rel/anchor."""
    internal, external = [], []
    seen_int = set()
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href or href.startswith(("mailto:", "tel:", "javascript:", "#", "data:")):
            continue
        full = norm(urljoin(page_url, href))
        if is_internal(full, host):
            if full not in seen_int:
                seen_int.add(full)
                internal.append(full)
            continue
        rel = " ".join(a.get("rel") or []) or ""
        anchor = re.sub(r"\s+", " ", a.get_text(" ", strip=True))[:200]
        external.append({"href": full, "rel": rel, "anchor": anchor})
    return internal, external


def parse_images(soup, page_url):
    out = []
    for img in soup.find_all("img"):
        src = (img.get("src") or img.get("data-src") or img.get("data-lazy-src") or "").strip()
        if not src:
            continue
        out.append({
            "src": urljoin(page_url, src),
            "alt": (img.get("alt") or "").strip(),
            "width": (img.get("width") or "").strip(),
            "height": (img.get("height") or "").strip(),
            "loading": (img.get("loading") or "").strip(),
        })
    return out


def parse_page(url, final_url, status, redirect_chain, content_type, html):
    soup = BeautifulSoup(html, "lxml")
    title = (soup.title.get_text(strip=True) if soup.title else "")
    md = soup.find("meta", attrs={"name": re.compile("^description$", re.I)})
    description = (md.get("content") or "").strip() if md else ""
    mr = soup.find("meta", attrs={"name": re.compile("^robots$", re.I)})
    meta_robots = (mr.get("content") or "").strip() if mr else ""
    canonical = ""
    link_c = soup.find("link", rel=lambda v: v and "canonical" in [x.lower() for x in v])
    if not link_c:
        link_c = soup.find("link", rel="canonical")
    if link_c and link_c.get("href"):
        canonical = urljoin(final_url or url, link_c["href"].strip())
    html_el = soup.find("html")
    lang = (html_el.get("lang") if html_el else "") or ""
    text = main_text(soup)
    jsonld_types, jsonld_blocks = parse_jsonld(soup)
    md_types, md_props = parse_microdata(soup)
    og, tw = parse_meta(soup)
    internal, external = parse_links(soup, final_url or url, urlparse(final_url or url).netloc)
    images = parse_images(soup, final_url or url)

    micro_short = [urlparse(t).path.strip("/") for t in md_types if t]
    types_union = sorted(set([t for t in jsonld_types] + micro_short))
    soft404 = bool(status == 200 and len(text) < 1200 and SOFT404_RE.search(title + " " + text[:600]))

    return {
        "url": url,
        "final_url": final_url or url,
        "status": status,
        "redirect_chain": redirect_chain,
        "content_type": content_type,
        "title": title,
        "title_len": len(title),
        "description": description,
        "description_len": len(description),
        "meta_robots": meta_robots,
        "canonical": canonical,
        "lang": lang,
        "headings": get_headings(soup),
        "h1": [h["text"] for h in get_headings(soup) if h["level"] == 1],
        "text": text,
        "text_len": len(text),
        "og": og,
        "twitter": tw,
        "jsonld_types": sorted(set(jsonld_types)),
        "jsonld_blocks": jsonld_blocks,
        "microdata_types": sorted(set(md_types)),
        "microdata_props": sorted(set(md_props)),
        "structured_types": types_union,
        "links_internal": internal,
        "links_external": external,
        "images": images,
        "soft404": soft404,
    }


def crawl(base, host, timeout, workers, limit, max_urls, do_link_check):
    session = requests.Session()
    session.headers.update(UA)

    print(f"[1/4] Sitemap и стартовые URL: {base}")
    sm_urls, sm_info = sitemap_urls(session, base, host, timeout)
    print(f"      sitemap: {'есть' if sm_info['found'] else 'нет'}"
          + (f" ({sm_info['urls']} URL)" if sm_info["found"] else ""))

    # robots.txt
    robots = {"status": 0, "text": ""}
    try:
        rr = session.get(urljoin(base, "/robots.txt"), headers=UA, timeout=timeout)
        robots = {"status": rr.status_code, "text": rr.text if rr.status_code == 200 else ""}
    except Exception:
        pass

    start = canon(base, host)
    seeds = [u for u in sm_urls if not skip_url(u, host)]
    if start not in seeds:
        seeds.insert(0, start)
    if limit and limit > 0 and len(seeds) > limit:
        # оставляем главную + первые limit
        seeds = seeds[:limit]

    seen = set()
    pages = []
    link_targets = {}
    frontier = list(dict.fromkeys(seeds))
    for u in frontier:
        seen.add(u)

    print(f"[2/4] Обход HTML-страниц (лимит страниц: {limit or 'без лимита'}, максимум URL: {max_urls})")

    def fetch_page(u):
        r = fetch(session, u, timeout, allow_redirects=True)
        if isinstance(r, Exception):
            return u, None, str(r)
        history = [{"status": h.status_code, "url": h.url} for h in r.history]
        ctype = r.headers.get("Content-Type", "")
        if "html" not in ctype.lower():
            return u, {"status": r.status_code, "final_url": r.url, "ctype": ctype,
                       "html": None, "redirect_chain": history}, None
        return u, {"status": r.status_code, "final_url": r.url, "ctype": ctype,
                   "html": r.text, "redirect_chain": history}, None

    with ThreadPoolExecutor(max_workers=workers) as ex:
        while frontier and (not limit or len(pages) < limit):
            batch = frontier[: max(workers * 2, 32)]
            frontier = frontier[len(batch):]
            futures = {ex.submit(fetch_page, u): u for u in batch}
            for fut in as_completed(futures):
                u = futures[fut]
                _u, data, err = fut.result()
                if err or not data:
                    continue
                if data["html"] is None:
                    continue
                page = parse_page(u, data["final_url"], data["status"], data["redirect_chain"],
                                  data["ctype"], data["html"])
                pages.append(page)
                if limit and len(pages) >= limit:
                    continue
                for href in page["links_internal"]:
                    if skip_url(href, host):
                        continue
                    link_targets.setdefault(href, set()).add(page["url"])
                    if href not in seen and len(seen) < max_urls:
                        seen.add(href)
                        frontier.append(href)
            if not frontier:
                break

    if limit and len(pages) >= limit:
        print(f"      достигнут лимит страниц: {len(pages)}")

    # Статусы внутренних ссылок (для п. 1.3): те, что ещё не обходили.
    # Карта откликов внутренних ссылок (для п. 1.3). Сначала берём уже обойдённые
    # страницы (для редиректов — первый код цепочки, а не финальный 200), затем
    # догоняем те ссылки, которые ещё не обходили.
    page_by_url = {p["url"]: p for p in pages}
    link_status = {}
    for target in link_targets:
        p = page_by_url.get(target)
        if not p:
            continue
        if p["redirect_chain"]:
            link_status[target] = {"status": p["redirect_chain"][0]["status"], "location": p["final_url"]}
        else:
            link_status[target] = {"status": p["status"], "location": ""}

    if do_link_check:
        targets = [u for u in link_targets if u not in link_status][:8000]
        print(f"[3/4] Проверка откликов внутренних ссылок: {len(targets)} URL")

        def check_link(u):
            r = fetch(session, u, timeout, allow_redirects=False)
            if isinstance(r, Exception):
                return u, {"status": 0, "location": "", "error": str(r)[:120]}
            loc = r.headers.get("Location", "")
            return u, {"status": r.status_code, "location": urljoin(u, loc) if loc else ""}

        with ThreadPoolExecutor(max_workers=workers) as ex:
            for u, st in ex.map(check_link, targets):
                link_status[u] = st
    else:
        print("[3/4] Проверка откликов ссылок пропущена (--no-link-check)")

    # внешние ссылки из собранных страниц (дедуп)
    ext = Counter()
    ext_rel = Counter()
    ext_sources = {}
    for p in pages:
        for l in p["links_external"]:
            ext[l["href"]] += 1
            if l["rel"]:
                ext_rel[l["rel"]] += 1
            ext_sources.setdefault(l["href"], p["url"])

    result = {
        "base": base,
        "host": host,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "sitemap": sm_info,
        "robots": robots,
        "pages": pages,
        "internal_link_status": link_status,
        "external_links": [{"href": k, "count": v, "source": ext_sources.get(k, "")}
                           for k, v in ext.most_common()],
        "external_rel": dict(ext_rel),
        "stats": {
            "pages": len(pages),
            "statuses": dict(Counter(p["status"] for p in pages)),
            "with_canonical": sum(1 for p in pages if p["canonical"]),
            "with_og": sum(1 for p in pages if p["og"]),
            "soft404": sum(1 for p in pages if p["soft404"]),
            "internal_links": len(link_targets),
            "external_links": len(ext),
        },
    }
    return result


def load_cached(path, max_age):
    try:
        if not os.path.exists(path):
            return None
        age = time.time() - os.path.getmtime(path)
        if age > max_age:
            return None
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(description="Общий краулер-коллектор для SEO-аудита")
    ap.add_argument("--url", required=True, help="URL сайта")
    ap.add_argument("--out", default="", help="путь к JSON (по умолчанию /tmp/opencode/seo_collect/<host>.json)")
    ap.add_argument("--limit", type=int, default=0, help="не более N страниц (0 — все)")
    ap.add_argument("--max-urls", type=int, default=5000, help="предохранительный лимит URL")
    ap.add_argument("--workers", type=int, default=24)
    ap.add_argument("--timeout", type=int, default=25)
    ap.add_argument("--no-link-check", action="store_true", help="не проверять отклики внутренних ссылок")
    ap.add_argument("--refresh", action="store_true", help="игнорировать кэш и пересобрать")
    ap.add_argument("--max-age", type=int, default=7200, help="время жизни кэша, сек")
    args = ap.parse_args()

    base = args.url if args.url.endswith("/") else args.url + "/"
    host = urlparse(base).netloc
    out = args.out or f"/tmp/opencode/seo_collect/{host}.json"
    os.makedirs(os.path.dirname(out), exist_ok=True)

    if not args.refresh:
        cached = load_cached(out, args.max_age)
        if cached and cached.get("pages"):
            print(f"Кэш найден и свежий: {out}")
            print(f"      страниц: {cached['stats']['pages']}, sitemap: {cached['sitemap'].get('urls', 0)} URL")
            print("      (пересобрать: --refresh)")
            print("OUT=" + out)
            return

    t0 = time.time()
    result = crawl(base, host, args.timeout, args.workers, args.limit,
                   args.max_urls, not args.no_link_check)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)

    st = result["stats"]
    print(f"[4/4] Сохранено: {out}")
    print(f"      страниц: {st['pages']} | статусы: {st['statuses']} | canonical: {st['with_canonical']}")
    print(f"      OG: {st['with_og']} | soft-404: {st['soft404']} | внутренних ссылок проверено: {st['internal_links']}")
    print(f"      внешних ссылок: {st['external_links']} | время: {time.time() - t0:.1f} с")
    print("OUT=" + out)


if __name__ == "__main__":
    main()
