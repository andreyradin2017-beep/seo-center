import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  applyReport, appendRun, appendPositions, diffReports, dueSchedules, formatRunMessage, issueKey, lastPositions, lastRun, normalizeAuditReport,
  normalizeSeverity, positionsDelta, readIssues, readPositions, readRuns, readSettings, saveSettings, scoreAudit, setIssueStatus,
} from "../lib/audit-store.ts"

const rawReport = {
  host: "example.com",
  site: "https://example.com/",
  generatedAt: "2026-11-01T10:00:00+03:00",
  points: [
    {
      point: "2.3", title: "Служебные теги", severity: "Высокая", checkedPages: 40,
      issues: ["Пустые title", { title: "Длинные description", severity: "Средняя", url: "https://example.com/a", fix: "Сократить" }],
      positive: ["H1 на всех страницах"],
    },
    { point: "4.1", title: "Скорость загрузки", checkedPages: 10, issues: [{ title: "LCP 5.2 c", severity: "low" }] },
  ],
}

test("severity is normalized from Russian and English words", () => {
  assert.equal(normalizeSeverity("Высокая"), "high")
  assert.equal(normalizeSeverity("critical"), "high")
  assert.equal(normalizeSeverity("Средняя"), "medium")
  assert.equal(normalizeSeverity("низкая"), "low")
  assert.equal(normalizeSeverity("непонятно"), "medium")
})

test("messy audit.json is normalized to a strict report", () => {
  const report = normalizeAuditReport(rawReport, "fallback")
  assert.ok(report)
  assert.equal(report.host, "example.com")
  assert.equal(report.points.length, 2)
  assert.equal(report.points[0].issues[0].title, "Пустые title")
  assert.equal(report.points[0].issues[0].severity, "high", "severity берётся с пункта")
  assert.equal(report.points[0].issues[1].severity, "medium")
  assert.deepEqual(report.points[0].issues[1].urls, ["https://example.com/a"])
  assert.equal(normalizeAuditReport({ points: [] }), null)
  assert.equal(normalizeAuditReport(null), null)
})

test("score and gate follow severity counts", () => {
  const clean = normalizeAuditReport({ points: [{ point: "1.1", title: "Адреса", issues: [] }] })
  assert.deepEqual(scoreAudit(clean), { score: 100, gate: "pass", counts: { high: 0, medium: 0, low: 0 }, total: 0 })
  const report = normalizeAuditReport(rawReport)
  const score = scoreAudit(report)
  assert.deepEqual(score.counts, { high: 1, medium: 1, low: 1 })
  assert.equal(score.score, 83)
  assert.equal(score.gate, "fail")
})

test("delta shows new, fixed and persisting issues", () => {
  const prev = normalizeAuditReport({ points: [{ point: "2.3", title: "Теги", issues: ["Старая проблема", "Общая проблема"] }] })
  const next = normalizeAuditReport({ points: [{ point: "2.3", title: "Теги", issues: ["Общая проблема", "Новая проблема"] }] })
  const delta = diffReports(prev, next)
  assert.deepEqual(delta.added.map((i) => i.title), ["Новая проблема"])
  assert.deepEqual(delta.fixed.map((i) => i.title), ["Старая проблема"])
  assert.equal(delta.persisting, 1)
  assert.equal(delta.scoreFrom, 92)
  assert.equal(delta.scoreTo, 92)
})

test("issue keys are stable for the same point and title", () => {
  assert.equal(issueKey("2.3", "Пустые title!"), issueKey("2.3", "  пустые   TITLE "))
  assert.notEqual(issueKey("2.3", "Пустые title"), issueKey("2.4", "Пустые title"))
})

test("issues remember status, reopen after a fix and mark vanished", () => {
  const root = mkdtempSync(join(tmpdir(), "seo-issues-"))
  try {
    const store = readIssues(root)
    const report = normalizeAuditReport(rawReport)
    const first = applyReport(store, "example.com", report, "run1", "2026-11-01T10:00:00Z")
    assert.equal(first.added, 3)
    const keys = Object.keys(store.hosts["example.com"].issues)
    assert.equal(keys.length, 3)

    const id = issueKey("2.3", "Пустые title")
    assert.equal(setIssueStatus(store, "example.com", id, "fixed"), true)
    assert.equal(setIssueStatus(store, "example.com", "nope", "fixed"), false)

    const second = applyReport(store, "example.com", report, "run2", "2026-11-02T10:00:00Z")
    assert.equal(store.hosts["example.com"].issues[id].status, "open", "вернувшаяся проблема снова открыта")
    assert.equal(second.reopened, 1)

    const clean = normalizeAuditReport({ points: [{ point: "2.3", title: "Теги", issues: [] }] })
    const third = applyReport(store, "example.com", clean, "run3", "2026-11-03T10:00:00Z")
    assert.equal(third.vanished, 3)
    assert.ok(store.hosts["example.com"].issues[id].vanishedAt)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("runs append and schedules become due on time", () => {
  const root = mkdtempSync(join(tmpdir(), "seo-runs-"))
  try {
    appendRun(root, { id: "r1", host: "example.com", site: "https://example.com/", at: "2026-11-01T10:00:00Z", dir: "d1", points: ["2.3"], score: 83, gate: "fail", counts: { high: 1, medium: 1, low: 1 } })
    const runs = readRuns(root)
    assert.equal(runs.runs.length, 1)
    assert.equal(runs.runs[0].score, 83)

    const settings = saveSettings(root, {
      schedules: [{ host: "example.com", site: "https://example.com/", points: [{ point: "2.3", skill: "sluzhebnye-tegi" }], everyDays: 7, hour: 9, enabled: true }],
    })
    assert.equal(readSettings(root).schedules.length, 1)
    const day = Date.UTC(2026, 10, 12, 10, 0, 0)
    assert.equal(dueSchedules(settings, day).length, 1)
    settings.schedules[0].lastRunAt = new Date(day - 2 * 86_400_000).toISOString()
    assert.equal(dueSchedules(settings, day).length, 0, "раз в 7 дней — рано")
    settings.schedules[0].lastRunAt = new Date(day - 8 * 86_400_000).toISOString()
    assert.equal(dueSchedules(settings, day).length, 1, "прошла неделя — пора")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("telegram message contains the gate, score and delta", () => {
  const message = formatRunMessage("example.com", { id: "r", host: "example.com", site: "", at: "", dir: "", points: [], score: 70, gate: "fail", counts: { high: 2, medium: 1, low: 0 } }, { scoreFrom: 60, scoreTo: 70, added: [], fixed: [], persisting: 3 })
  assert.match(message, /SEO-аудит: example\.com/)
  assert.match(message, /70\/100/)
  assert.match(message, /60 → 70/)
})

test("run record keeps audit parameters (depths, semcore)", () => {
  const root = mkdtempSync(join(tmpdir(), "seo-runparams-"))
  try {
    appendRun(root, { id: "r1", host: "example.com", site: "https://example.com/", at: "2026-11-01T10:00:00Z", dir: "d1", points: ["2.3"], score: 80, gate: "warn", counts: { high: 0, medium: 2, low: 0 }, depthContent: 60, depthSpeed: 15, semcoreMsg: "ядро", semcorePath: "/u/semcore.xlsx" })
    const runs = readRuns(root).runs
    assert.equal(runs[0].depthContent, 60)
    assert.equal(runs[0].depthSpeed, 15)
    assert.equal(runs[0].semcoreMsg, "ядро")
    assert.equal(runs[0].semcorePath, "/u/semcore.xlsx")
    const last = lastRun(root, "example.com")
    assert.equal(last.depthContent, 60)
    assert.equal(last.depthSpeed, 15)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("issue status transitions are validated", () => {
  const root = mkdtempSync(join(tmpdir(), "seo-transitions-"))
  try {
    const store = readIssues(root)
    const report = normalizeAuditReport(rawReport)
    applyReport(store, "example.com", report, "run1", "2026-11-01T10:00:00Z")
    const id = issueKey("2.3", "Пустые title")
    assert.equal(setIssueStatus(store, "example.com", id, "in_progress"), true)
    assert.equal(setIssueStatus(store, "example.com", id, "fixed"), true)
    // fixed ->ignored недопустим
    assert.equal(setIssueStatus(store, "example.com", id, "ignored"), false)
    assert.equal(store.hosts["example.com"].issues[id].status, "fixed")
    // fixed -> open допустим (регресс)
    assert.equal(setIssueStatus(store, "example.com", id, "open"), true)
    assert.equal(store.hosts["example.com"].issues[id].status, "open")
    // несуществующая проблема
    assert.equal(setIssueStatus(store, "example.com", "nope", "open"), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("positions append, read and lastPositions filter by host and date", () => {
  const root = mkdtempSync(join(tmpdir(), "seo-positions-"))
  try {
    appendPositions(root, [
      { id: "p1", host: "example.com", site: "https://example.com/", date: "2026-11-01", query: "купить котел", page: "https://example.com/catalog/", position: 5, clicks: 10, impressions: 100, ctr: 0.1, source: "gsc" },
      { id: "p2", host: "example.com", site: "https://example.com/", date: "2026-11-01", query: "котел цена", page: "https://example.com/catalog/", position: 12, clicks: 3, impressions: 50, ctr: 0.06, source: "gsc" },
      { id: "p3", host: "other.com", site: "https://other.com/", date: "2026-11-01", query: "тест", page: "https://other.com/", position: 1, clicks: 0, impressions: 0, ctr: 0, source: "gsc" },
    ])
    const all = readPositions(root)
    assert.equal(all.positions.length, 3)
    const example = lastPositions(root, "example.com", "2026-11-01")
    assert.equal(example.length, 2)
    assert.equal(example[0].query, "купить котел")
    assert.equal(example[0].position, 5)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("positions delta shows position change between dates", () => {
  const root = mkdtempSync(join(tmpdir(), "seo-positions-delta-"))
  try {
    appendPositions(root, [
      { id: "p1", host: "example.com", site: "https://example.com/", date: "2026-11-01", query: "купить котел", page: "https://example.com/catalog/", position: 5, clicks: 10, impressions: 100, ctr: 0.1, source: "gsc" },
      { id: "p2", host: "example.com", site: "https://example.com/", date: "2026-11-08", query: "купить котел", page: "https://example.com/catalog/", position: 3, clicks: 15, impressions: 120, ctr: 0.125, source: "gsc" },
    ])
    const delta = positionsDelta(root, "example.com", "2026-11-01", "2026-11-08")
    assert.equal(delta.length, 1)
    assert.equal(delta[0].query, "купить котел")
    assert.equal(delta[0].positionFrom, 5)
    assert.equal(delta[0].positionTo, 3)
    assert.equal(delta[0].change, -2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
