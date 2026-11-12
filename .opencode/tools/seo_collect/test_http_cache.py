#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Тест общего HTTP-кэша: stdlib unittest + локальный http.server."""
import base64
import gzip
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import http_cache

HITS = {}
BODY = '<html><body><h1>Привет</h1></body></html>'.encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        HITS[self.path] = HITS.get(self.path, 0) + 1
        if self.path == "/missing":
            body = b"not found"
            self.send_response(404)
        else:
            body = BODY
            self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


class CacheTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        HITS.clear()
        self.cache_dir = tempfile.mkdtemp(prefix="http-cache-test-")

    def tearDown(self):
        shutil.rmtree(self.cache_dir, ignore_errors=True)

    def test_cache_hit_single_server_request(self):
        url = self.base + "/cached"
        r1 = http_cache.get(url, cache_dir=self.cache_dir)
        r2 = http_cache.get(url, cache_dir=self.cache_dir)
        self.assertEqual(HITS["/cached"], 1)
        for r in (r1, r2):
            self.assertEqual(r.status_code, 200)
            self.assertTrue(r.ok)
            self.assertEqual(r.content, BODY)
            self.assertIn("Привет", r.text)
            self.assertEqual(r.url, url)
            self.assertEqual(r.headers.get("Content-Type"), "text/html; charset=utf-8")
            r.raise_for_status()

        files = [f for f in os.listdir(self.cache_dir) if f.endswith(".json.gz")]
        self.assertEqual(len(files), 1)
        with gzip.open(os.path.join(self.cache_dir, files[0]), "rt", encoding="utf-8") as f:
            data = json.load(f)
        for key in ("url", "status", "headers", "encoding", "body_base64", "fetched_at"):
            self.assertIn(key, data)
        self.assertEqual(base64.b64decode(data["body_base64"]), BODY)

    def test_no_cache_two_server_requests(self):
        url = self.base + "/no-cache"
        http_cache.get(url)
        http_cache.get(url)
        self.assertEqual(HITS["/no-cache"], 2)

    def test_http_error_from_cache(self):
        url = self.base + "/missing"
        r1 = http_cache.get(url, cache_dir=self.cache_dir)
        self.assertEqual(r1.status_code, 404)
        self.assertFalse(r1.ok)
        with self.assertRaises(requests.HTTPError):
            r1.raise_for_status()

        r2 = http_cache.get(url, cache_dir=self.cache_dir)
        self.assertEqual(HITS["/missing"], 1)
        self.assertEqual(r2.status_code, 404)
        with self.assertRaises(requests.HTTPError):
            r2.raise_for_status()

    def test_ttl_expired_refetches(self):
        url = self.base + "/ttl"
        http_cache.get(url, cache_dir=self.cache_dir)
        http_cache.get(url, cache_dir=self.cache_dir, ttl=-1)
        self.assertEqual(HITS["/ttl"], 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
