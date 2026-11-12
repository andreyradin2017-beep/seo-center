import assert from "node:assert/strict"
import test from "node:test"
import { buildJsonLd, buildRobots, buildSitemap, isIsoDate, jsonLdTemplate, normalizeUrlList, urlsFromCsv } from "../lib/generators.ts"

test("robots always closes query parameters and lists sitemaps", () => {
  const text = buildRobots({ sitemaps: ["https://example.com/sitemap.xml"], disallow: ["/admin/"], allow: ["/admin/login"] })
  assert.match(text, /^User-agent: \*/m)
  assert.match(text, /^Allow: \/admin\/login$/m)
  assert.match(text, /^Disallow: \/admin\/$/m)
  assert.match(text, /^Disallow: \/\*\?$/m)
  assert.match(text, /^Sitemap: https:\/\/example\.com\/sitemap\.xml$/m)
  assert.doesNotMatch(buildRobots({ cleanParams: false }), /Disallow: \/\*\?/)
  assert.doesNotMatch(buildRobots({ sitemaps: ["javascript:alert(1)"] }), /Sitemap:/)
})

test("sitemap dedupes, strips fragments, escapes and drops bad urls", () => {
  const xml = buildSitemap([
    "https://example.com/b",
    "https://example.com/a?x=1&y=2",
    "https://example.com/a?x=1&y=2#frag",
    "ftp://example.com/file",
    "not a url",
  ], { lastmod: "2026-11-12" })
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/)
  assert.equal((xml.match(/<url>/g) || []).length, 2)
  assert.match(xml, /https:\/\/example\.com\/a\?x=1&amp;y=2/)
  assert.doesNotMatch(xml, /#frag/)
  assert.doesNotMatch(xml, /ftp:/)
  assert.doesNotMatch(buildSitemap(["https://example.com/"], { lastmod: "12.11.2026" }), /lastmod/)
})

test("urls from a results csv take the first column", () => {
  assert.deepEqual(urlsFromCsv('URL,title\n"https://example.com/a",A\nhttps://example.com/b;B\nnope,C\n'), ["https://example.com/a", "https://example.com/b"])
  assert.deepEqual(normalizeUrlList(["https://example.com/a", "https://example.com/a"]), ["https://example.com/a"])
})

test("json-ld validates required fields and ISO dates", () => {
  const ok = buildJsonLd("Article", { headline: "H", image: ["https://example.com/i.jpg"], datePublished: "2026-01-01T10:00:00+03:00", author: { "@type": "Person", name: "A" } })
  assert.equal(ok.ok, true)
  assert.match(ok.script, /"@context": "https:\/\/schema\.org"/)
  assert.match(ok.script, /"@type": "Article"/)

  const bad = buildJsonLd("Article", { headline: "H", datePublished: "01.01.2026", author: "A" })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some((e) => e.includes("image")))
  assert.ok(bad.errors.some((e) => e.includes("ISO 8601")))
  assert.equal(buildJsonLd("WebSite", {}).ok, false, "типы не из справочника запрещены")
})

test("breadcrumb requires position, name and item on all but the last element", () => {
  const result = buildJsonLd("BreadcrumbList", { itemListElement: [{ "@type": "ListItem", position: 1, name: "Главная" }, { "@type": "ListItem", position: 2, name: "Текущая" }] })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("itemListElement[0]")))
  assert.equal(isIsoDate("2026-11-12"), true)
  assert.equal(isIsoDate("2026-11-12T10:30:00+03:00"), true)
  assert.equal(isIsoDate("12.11.2026"), false)
  assert.ok(jsonLdTemplate("BreadcrumbList").itemListElement.length)
})
