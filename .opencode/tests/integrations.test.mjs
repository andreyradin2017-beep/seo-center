import assert from "node:assert/strict"
import test from "node:test"
import { gscQueries, gscSites, metrikaSummary, psiCheck, webmasterHosts, webmasterIndexing, wordstatFrequency } from "../lib/integrations.ts"

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body }
}

function mockFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { calls, fetchImpl }
}

test("PSI returns normalized scores, lab and field data", async () => {
  const { calls, fetchImpl } = mockFetch(() => response({
    id: "https://example.com/",
    lighthouseResult: {
      categories: {
        performance: { score: 0.92 },
        seo: { score: 1 },
        accessibility: { score: 0.88 },
        "best-practices": { score: 0.96 },
      },
      audits: {
        "largest-contentful-paint": { numericValue: 2100.4 },
        "cumulative-layout-shift": { numericValue: 0.054 },
        "total-blocking-time": { numericValue: 130 },
        "interaction-to-next-paint": { numericValue: 180 },
      },
    },
    loadingExperience: {
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2500 },
        CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 8 },
        INTERACTION_TO_NEXT_PAINT: { percentile: 210 },
      },
    },
  }))

  const result = await psiCheck({ url: "https://example.com/", apiKey: "psi-key", fetchImpl })

  assert.equal(result.ok, true)
  assert.equal(result.kind, "psi")
  assert.deepEqual(result.data.scores, { performance: 92, seo: 100, accessibility: 88, bestPractices: 96 })
  assert.deepEqual(result.data.lab, { lcpMs: 2100, cls: 0.054, inpMs: 180, tbtMs: 130 })
  assert.deepEqual(result.data.field, { lcpMs: 2500, cls: 0.08, inpMs: 210 })
  assert.match(result.summary, /performance 92/)
  assert.match(result.summary, /LCP 2\.1 с/)
  assert.match(result.summary, /INP 180 мс/)

  const url = new URL(calls[0].url)
  assert.equal(url.hostname, "pagespeedonline.googleapis.com")
  assert.equal(url.pathname, "/pagespeedonline/v5/runPagespeed")
  assert.equal(url.searchParams.get("key"), "psi-key")
  assert.equal(url.searchParams.get("strategy"), "mobile")
  assert.deepEqual(url.searchParams.getAll("category"), ["performance", "seo", "accessibility", "best-practices"])
})

test("PSI without an API key fails with a hint and makes no request", async () => {
  const { calls, fetchImpl } = mockFetch(() => response({}))
  const result = await psiCheck({ url: "https://example.com/", fetchImpl })

  assert.equal(result.ok, false)
  assert.equal(result.kind, "psi")
  assert.match(result.error, /API-ключ/)
  assert.equal(calls.length, 0)
})

test("GSC queries encode siteUrl, send Bearer token and normalize rows", async () => {
  const siteUrl = "https://example.com/"
  const { calls, fetchImpl } = mockFetch(() => response({
    rows: [
      { keys: ["купить стол"], clicks: 12, impressions: 340, ctr: 0.0353, position: 4.26 },
      { keys: ["стол цена"], clicks: 3, impressions: 90, ctr: 0.0333, position: 8.1 },
    ],
  }))

  const result = await gscQueries({
    token: "gsc-token",
    siteUrl,
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    limit: 50,
    fetchImpl,
  })

  assert.equal(result.ok, true)
  assert.equal(result.kind, "gsc")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.headers.Authorization, "Bearer gsc-token")
  assert.ok(calls[0].url.includes(`/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`))

  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body, { startDate: "2026-01-01", endDate: "2026-01-31", dimensions: ["query"], rowLimit: 50 })
  assert.deepEqual(result.data.queries[0], { query: "купить стол", clicks: 12, impressions: 340, ctr: 0.0353, position: 4.3 })
  assert.equal(result.data.queries.length, 2)
})

test("GSC sites sends Bearer token and maps siteEntry", async () => {
  const { calls, fetchImpl } = mockFetch(() => response({
    siteEntry: [{ siteUrl: "https://example.com/", permissionLevel: "siteOwner" }],
  }))

  const result = await gscSites({ token: "gsc-token", fetchImpl })

  assert.equal(result.ok, true)
  assert.equal(calls[0].init.headers.Authorization, "Bearer gsc-token")
  assert.deepEqual(result.data.sites, [{ siteUrl: "https://example.com/", permissionLevel: "siteOwner" }])
})

test("Webmaster hosts sends OAuth header and resolves user_id first", async () => {
  const { calls, fetchImpl } = mockFetch((url) => {
    if (url.endsWith("/user/")) return response({ user_id: 42, login: "demo" })
    return response({
      hosts: [
        { host_id: "https:example.com:443", ascii_host_url: "https://example.com/", unicode_host_url: "https://example.com/", verified: true },
        { host_id: "http:example.org:80", ascii_host_url: "http://example.org/", verified: false },
      ],
    })
  })

  const result = await webmasterHosts({ token: "ym-token", fetchImpl })

  assert.equal(result.ok, true)
  assert.equal(result.kind, "webmaster")
  assert.equal(calls.length, 2)
  assert.equal(calls[0].init.headers.Authorization, "OAuth ym-token")
  assert.equal(calls[1].init.headers.Authorization, "OAuth ym-token")
  assert.ok(calls[1].url.endsWith("/user/42/hosts/"))
  assert.deepEqual(result.data.hosts, [
    { hostId: "https:example.com:443", url: "https://example.com/", verified: true },
    { hostId: "http:example.org:80", url: "http://example.org/", verified: false },
  ])
})

test("Webmaster indexing returns latest values and a trend", async () => {
  const { calls, fetchImpl } = mockFetch((url) => {
    if (url.endsWith("/user/")) return response({ user_id: 42 })
    return response({
      history: [
        { date: "2026-01-31", searchable_pages_count: 120, excluded_pages_count: 4 },
        { date: "2026-01-01", searchable_pages_count: 90, excluded_pages_count: 2 },
      ],
    })
  })

  const result = await webmasterIndexing({ token: "ym-token", hostId: "https:example.com:443", fetchImpl })

  assert.equal(result.ok, true)
  assert.ok(calls[1].url.includes(`/hosts/${encodeURIComponent("https:example.com:443")}/indexing/history?`))
  assert.deepEqual(result.data.latest, { date: "2026-01-31", searchablePages: 120, excludedPages: 4 })
  assert.equal(result.data.trend, "up")
  assert.equal(result.data.change, 30)
  assert.equal(result.data.points.length, 2)
  assert.match(result.summary, /120 страниц/)
})

test("Metrika sends OAuth token and date range, reads totals", async () => {
  const { calls, fetchImpl } = mockFetch(() => response({ totals: [[120, 100, 450]] }))

  const result = await metrikaSummary({
    token: "metrika-token",
    counterId: "12345",
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    fetchImpl,
  })

  assert.equal(result.ok, true)
  assert.equal(result.kind, "metrika")
  assert.equal(calls[0].init.headers.Authorization, "OAuth metrika-token")

  const url = new URL(calls[0].url)
  assert.equal(url.origin + url.pathname, "https://api-metrika.yandex.net/stat/v1/data")
  assert.equal(url.searchParams.get("ids"), "12345")
  assert.equal(url.searchParams.get("metrics"), "ym:s:visits,ym:s:users,ym:s:pageviews")
  assert.equal(url.searchParams.get("date1"), "2026-01-01")
  assert.equal(url.searchParams.get("date2"), "2026-01-31")
  assert.deepEqual(result.data, { counterId: "12345", startDate: "2026-01-01", endDate: "2026-01-31", visits: 120, users: 100, pageviews: 450 })
})

test("invalid date is rejected before any request", async () => {
  const { calls, fetchImpl } = mockFetch(() => response({ rows: [] }))
  const result = await gscQueries({ token: "t", siteUrl: "https://example.com/", startDate: "2026-1-01", endDate: "2026-01-31", fetchImpl })

  assert.equal(result.ok, false)
  assert.match(result.error, /YYYY-MM-DD/)
  assert.equal(calls.length, 0)
})

test("network errors become failed results instead of throwing", async () => {
  const fetchImpl = async () => {
    throw new TypeError("fetch failed")
  }
  const result = await psiCheck({ url: "https://example.com/", apiKey: "key", fetchImpl })

  assert.equal(result.ok, false)
  assert.equal(result.kind, "psi")
  assert.match(result.error, /Сетевая ошибка: fetch failed/)
})

test("non-2xx responses return status and body snippet", async () => {
  const { fetchImpl } = mockFetch(() => response({ message: "forbidden" }, 403))
  const result = await metrikaSummary({ token: "t", counterId: "1", startDate: "2026-01-01", endDate: "2026-01-31", fetchImpl })

  assert.equal(result.ok, false)
  assert.equal(result.kind, "metrika")
  assert.match(result.error, /HTTP 403/)
  assert.match(result.error, /forbidden/)
})

test("Wordstat sends Api-Key and x-folder-id, maps phrases with frequencies", async () => {
  const { calls, fetchImpl } = mockFetch(() => response({
    phrases: [
      { phrase: "купить котел", frequency: 1200 },
      { phrase: "котел цена", frequency: 850 },
    ],
  }))

  const result = await wordstatFrequency({
    apiKey: "ws-key",
    folderId: "b1gabc123",
    phrases: ["купить котел", "котел цена"],
    fetchImpl,
  })

  assert.equal(result.ok, true)
  assert.equal(result.kind, "wordstat")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.headers.Authorization, "Api-Key ws-key")
  assert.equal(calls[0].init.headers["x-folder-id"], "b1gabc123")
  assert.ok(calls[0].url.endsWith("/v2/wordstat/phrases"))

  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body.phrases, ["купить котел", "котел цена"])

  assert.deepEqual(result.data.phrases, [
    { phrase: "купить котел", frequency: 1200, region: null },
    { phrase: "котел цена", frequency: 850, region: null },
  ])
})

test("Wordstat without API key fails and makes no request", async () => {
  const { calls, fetchImpl } = mockFetch(() => response({}))
  const result = await wordstatFrequency({ phrases: ["купить котел"], fetchImpl })

  assert.equal(result.ok, false)
  assert.equal(result.kind, "wordstat")
  assert.match(result.error, /API-ключ/)
  assert.equal(calls.length, 0)
})

test("Wordstat without folderId fails and makes no request", async () => {
  const { calls, fetchImpl } = mockFetch(() => response({}))
  const result = await wordstatFrequency({ apiKey: "ws-key", phrases: ["купить котел"], fetchImpl })

  assert.equal(result.ok, false)
  assert.equal(result.kind, "wordstat")
  assert.match(result.error, /идентификатор каталога/)
  assert.equal(calls.length, 0)
})

test("Wordstat without phrases fails and makes no request", async () => {
  const { calls, fetchImpl } = mockFetch(() => response({}))
  const result = await wordstatFrequency({ apiKey: "ws-key", folderId: "b1g", fetchImpl })

  assert.equal(result.ok, false)
  assert.equal(result.kind, "wordstat")
  assert.match(result.error, /хотя бы одну фразу/)
  assert.equal(calls.length, 0)
})
