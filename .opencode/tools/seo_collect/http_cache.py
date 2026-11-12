#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Общий HTTP-кэш для скриптов SEO-аудита.

Зачем: полный аудит запускает несколько пунктов (текст, заголовки, теги, изображения,
ссылки), и каждый заново обходит одни и те же страницы сайта. С кэшем страница
скачивается один раз, остальные пункты берут её с диска.

Как включить: передать всем скриптам аудита один и тот же каталог, например
  python content_audit.py --url https://example.ru/ --out-dir out --cache out/.cache
Кэшируются только GET-запросы. Ключ — sha256 от URL, заголовков и allow_redirects,
поэтому разные User-Agent не смешиваются. Файл: <cache_dir>/<ключ>.json.gz.

TTL по умолчанию — 2 часа (ttl=7200): файл свежее TTL отдаётся из кэша, иначе страница
запрашивается заново и файл перезаписывается. Очистка — удалить каталог кэша целиком
(rm -rf out/.cache). При пустом cache_dir функция работает как обычный requests.get.
"""
import base64
import gzip
import hashlib
import json
import os
import tempfile
import time

import requests


class CachedResponse:
    """Подмножество requests.Response, которое используют скрипты аудита."""

    def __init__(self, url, status_code, headers, encoding, content):
        self.url = url
        self.status_code = int(status_code)
        self.headers = dict(headers or {})
        self.encoding = encoding
        self.content = content or b""
        self.ok = self.status_code < 400

    @property
    def text(self):
        return self.content.decode(self.encoding or "utf-8", errors="replace")

    def raise_for_status(self):
        if 400 <= self.status_code < 500:
            raise requests.HTTPError(f"{self.status_code} Client Error: {self.url}", response=self)
        if 500 <= self.status_code < 600:
            raise requests.HTTPError(f"{self.status_code} Server Error: {self.url}", response=self)


def _key(url, headers, allow_redirects):
    hdrs = sorted((str(k).lower(), str(v)) for k, v in (headers or {}).items())
    raw = json.dumps([url, hdrs, bool(allow_redirects)], ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _read(path):
    try:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError, EOFError):
        return None
    return data if isinstance(data, dict) else None


def _write(path, payload):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-", suffix=".json.gz")
    os.close(fd)
    try:
        with gzip.open(tmp, "wt", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def get(url, *, timeout=25, headers=None, allow_redirects=True, cache_dir=None, ttl=7200):
    """GET с дисковым кэшем. cache_dir=None/"" — обычный requests.get без кэша."""
    if not cache_dir:
        return requests.get(url, headers=headers, timeout=timeout, allow_redirects=allow_redirects)

    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, _key(url, headers, allow_redirects) + ".json.gz")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < ttl:
        data = _read(path)
        if data is not None:
            return CachedResponse(
                data.get("url") or url, data.get("status", 0), data.get("headers"),
                data.get("encoding"), base64.b64decode(data.get("body_base64") or ""),
            )

    r = requests.get(url, headers=headers, timeout=timeout, allow_redirects=allow_redirects)
    payload = {
        "url": r.url or url,
        "status": r.status_code,
        "headers": dict(r.headers),
        "encoding": r.encoding or r.apparent_encoding,
        "body_base64": base64.b64encode(r.content or b"").decode("ascii"),
        "fetched_at": time.time(),
    }
    _write(path, payload)
    return r
