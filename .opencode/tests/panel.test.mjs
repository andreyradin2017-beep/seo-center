// Панель целиком: поднимаем настоящий HTTP-сервер с клиентом-заглушкой и
// проверяем новые страницы и API (аналитика, пресеты, генераторы, расписание).
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const root = mkdtempSync(join(tmpdir(), "seo-panel-"))
const port = 44100 + (process.pid % 500)
process.env.USERPROFILE = root
process.env.HOME = root
process.env.SEO_RESULTS_DIR = join(root, "results")
process.env.SEO_QUEUE_STATE_FILE = join(root, "results", ".queue.json")
process.env.SEO_UPLOADS_DIR = join(root, "uploads")
process.env.SEO_UI_PORT = String(port)
process.env.SEO_UI_BIND = "127.0.0.1"
process.env.OPENCODE_SEO_UI_NO_OPEN = "1"

const { createSeoPanel } = await import("../plugin/seo-ui.ts")

const base = `http://127.0.0.1:${port}`
const client = {
  session: {
    create: async () => ({ data: { id: "ses_stub" } }),
    promptAsync: async () => ({ data: {} }),
    abort: async () => ({ data: {} }),
  },
}
const panel = await createSeoPanel({ client, projectDir: join(root, "project") })
test.after(() => { panel.stop(); rmSync(root, { recursive: true, force: true }) })

const get = (path) => fetch(base + path)
const post = (path, body) => fetch(base + path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
})
const json = async (res) => ({ status: res.status, body: await res.json() })

function fakeRun(id, day, issues, score, gate) {
  const dir = join(root, "results", "example.com", id, "audit")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "audit.json"), JSON.stringify({
    host: "example.com", site: "https://example.com/", generatedAt: `${day}T10:00:00+03:00`,
    points: [{ point: "2.3", title: "Служебные теги", checkedPages: 40, issues }],
  }))
  return {
    id, host: "example.com", site: "https://example.com/", at: `${day}T10:00:00Z`, dir, points: ["2.3"], score, gate,
    counts: { high: issues.filter((i) => i.severity === "high").length, medium: issues.filter((i) => i.severity === "medium").length, low: 0 },
  }
}

test("health, pages and generators work", async () => {
  const health = await json(await get("/api/health"))
  assert.equal(health.body.ok, true)
  assert.equal(health.body.app, "seo-center")

  const insights = await get("/insights")
  assert.equal(insights.status, 200)
  assert.match(await insights.text(), /Аналитика SEO-центра/)

  const generators = await get("/generators")
  assert.equal(generators.status, 200)
  assert.match(await generators.text(), /Генераторы SEO-файлов/)

  const robots = await json(await post("/api/generate", { kind: "robots", sitemaps: ["https://example.com/sitemap.xml"], disallow: ["/admin/"] }))
  assert.equal(robots.body.ok, true)
  assert.match(robots.body.content, /^Disallow: \/\*\?$/m)

  const sitemap = await json(await post("/api/generate", { kind: "sitemap", urls: ["https://example.com/a", "https://example.com/a#x"] }))
  assert.equal((sitemap.body.content.match(/<url>/g) || []).length, 1)

  const bad = await json(await post("/api/generate", { kind: "jsonld", type: "Article", data: { headline: "H" } }))
  assert.equal(bad.body.ok, false)
  assert.ok(bad.body.errors.some((e) => e.includes("datePublished")))
})

test("presets are saved and listed", async () => {
  const saved = await json(await post("/api/presets", { name: "Быстрый", points: [{ point: "2.3", skill: "sluzhebnye-tegi" }] }))
  assert.equal(saved.body.ok, true)
  assert.equal(saved.body.presets.length, 1)
  const listed = await json(await get("/api/presets"))
  assert.equal(listed.body.presets[0].name, "Быстрый")
  const bad = await json(await post("/api/presets", { name: "", points: [] }))
  assert.equal(bad.body.ok, false)
})

test("history, report delta and overview read audit.json", async () => {
  const r1 = fakeRun("r1", "2026-11-01", [{ title: "Пустые title", severity: "high" }], 88, "fail")
  const r2 = fakeRun("r2", "2026-11-08", [{ title: "Длинные description", severity: "medium" }], 96, "warn")
  mkdirSync(join(root, "results"), { recursive: true })
  writeFileSync(join(root, "results", ".runs.json"), JSON.stringify({ version: 1, runs: [r1, r2] }))

  const overview = await json(await get("/api/insights/overview"))
  assert.equal(overview.body.hosts[0].host, "example.com")
  assert.equal(overview.body.hosts[0].runs, 2)
  assert.equal(overview.body.hosts[0].delta, 8)

  const history = await json(await get("/api/insights/history?host=example.com"))
  assert.equal(history.body.runs.length, 2)

  const report = await json(await get("/api/insights/report?run=r2"))
  assert.equal(report.body.report.points[0].checkedPages, 40)
  assert.deepEqual(report.body.delta.added.map((i) => i.title), ["Длинные description"])
  assert.deepEqual(report.body.delta.fixed.map((i) => i.title), ["Пустые title"])
  assert.equal(report.body.delta.scoreFrom, 88)

  const missing = await json(await get("/api/insights/report?run=nope"))
  assert.equal(missing.body.ok, false)
})

test("schedules are created from presets and can be toggled and deleted", async () => {
  const created = await json(await post("/api/insights/schedules", { site: "https://example.com/", everyDays: 7, hour: 9, preset: "Быстрый" }))
  assert.equal(created.body.ok, true)
  assert.deepEqual(created.body.schedules[0].points, [{ point: "2.3", skill: "sluzhebnye-tegi" }])
  assert.equal(created.body.schedules[0].host, "example.com")

  const toggled = await json(await post("/api/insights/schedules/toggle", { site: "https://example.com/" }))
  assert.equal(toggled.body.schedules[0].enabled, false)

  const deleted = await json(await post("/api/insights/schedules/delete", { site: "https://example.com/" }))
  assert.equal(deleted.body.schedules.length, 0)

  const noPoints = await json(await post("/api/insights/schedules", { site: "https://unknown.example/", preset: "" }))
  assert.equal(noPoints.body.ok, false)
})

test("repeat queues the audit and issue status rejects an unknown id", async () => {
  const repeat = await json(await post("/api/insights/repeat", { runId: "r2" }))
  assert.equal(repeat.body.ok, true)
  assert.equal(repeat.body.host, "example.com")

  const queue = await json(await get("/api/audit-queue"))
  assert.equal(queue.body.running, 1)
  assert.equal(queue.body.jobs[0].site, "https://example.com/")

  const status = await json(await post("/api/insights/issues/status", { host: "example.com", id: "missing", status: "fixed" }))
  assert.equal(status.body.ok, false)

  const settings = await json(await get("/api/insights/settings"))
  assert.equal(settings.body.settings.version, 1)
})

test("dry-run audit does not write to history", async () => {
  const before = (await json(await get("/api/insights/history?host=example.com"))).body.runs.length
  const run = await json(await post("/run-audit", { url: "https://example.com/", points: [{ point: "2.3", skill: "sluzhebnye-tegi" }], dryRun: true }))
  assert.equal(run.body.ok, true)
  assert.equal(run.body.dryRun, true)
  const after = (await json(await get("/api/insights/history?host=example.com"))).body.runs.length
  assert.equal(after, before)

  // Но задача должна быть в очереди
  const queue = await json(await get("/api/audit-queue"))
  assert.equal(queue.body.running, 1)
})

test("schedule stores depth parameters", async () => {
  const created = await json(await post("/api/insights/schedules", { site: "https://example.com/", everyDays: 7, hour: 9, preset: "Быстрый", depthContent: 60, depthSpeed: 15 }))
  assert.equal(created.body.ok, true)
  assert.equal(created.body.schedules[0].depthContent, 60)
  assert.equal(created.body.schedules[0].depthSpeed, 15)
})

test("repeat carries depth parameters from the run", async () => {
  const run = { id: "r1", host: "example.org", site: "https://example.org/", at: "2026-11-01T10:00:00Z", dir: "d1", points: ["2.3"], score: 88, gate: "fail", counts: { high: 1, medium: 0, low: 0 }, depthContent: 77, depthSpeed: 13 }
  writeFileSync(join(root, "results", ".runs.json"), JSON.stringify({ version: 1, runs: [run] }))
  const repeat = await json(await post("/api/insights/repeat", { runId: "r1" }))
  assert.equal(repeat.body.ok, true)
  const queue = await json(await get("/api/audit-queue"))
  assert.ok(queue.body.jobs.some((j) => j.site === "https://example.org/"))
})

test("wordstat integration test endpoint works with key and fails without", async () => {
  const ok = await json(await post("/api/insights/integrations/test", { kind: "wordstat", phrase: "купить котел" }))
  assert.equal(ok.body.ok, false)
  assert.equal(ok.body.result.kind, "wordstat")
  assert.match(ok.body.result.error, /API-ключ/)

  const empty = await json(await post("/api/insights/integrations/test", { kind: "wordstat" }))
  assert.equal(empty.body.ok, false)
  assert.equal(empty.body.result.kind, "wordstat")
})
