// Машиночитаемый результат аудита, история прогонов, проблемы и настройки.
// Всё, что панель считает сама, а не берёт из текста docx: скор, гейт, дельта,
// статусы проблем, расписание. Чистые функции — для тестов, файловые — для панели.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeJsonAtomic } from "./json-store.ts"

export const SEVERITIES = ["high", "medium", "low"] as const
export type Severity = (typeof SEVERITIES)[number]

export interface AuditIssue {
  point: string
  title: string
  severity: Severity
  urls: string[]
  fix: string
  count: number
}
export interface AuditPoint {
  point: string
  title: string
  checkedPages: number
  summary: string
  issues: AuditIssue[]
  positive: string[]
}
export interface AuditReport {
  version: 1
  host: string
  site: string
  generatedAt: string
  points: AuditPoint[]
  summary: string
  sitemapCoverage?: any
}
export interface AuditScore {
  score: number
  gate: "pass" | "warn" | "fail"
  counts: { high: number; medium: number; low: number }
  total: number
}

const SEVERITY_ALIASES: Record<string, Severity> = {
  high: "high", critical: "high", крит: "high", критичная: "high", критично: "high", высокая: "high", высокий: "high",
  medium: "medium", средняя: "medium", средний: "medium", умеренная: "medium",
  low: "low", низкая: "low", низкий: "low", мелкая: "low", косметика: "low",
}

export function normalizeSeverity(raw: unknown, fallback: Severity = "medium"): Severity {
  const key = String(raw ?? "").trim().toLowerCase()
  return SEVERITY_ALIASES[key] || fallback
}

function text(raw: unknown, max = 500): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, max)
}

function urlList(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : raw ? [raw] : []
  return [...new Set(items.map((u) => text(u, 300)).filter((u) => /^https?:\/\//i.test(u)))].slice(0, 200)
}

export function issueKey(point: string, title: string): string {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return `${text(point, 12)}:${slug}`
}

// Принимает то, что реально пишет модель: severity может стоять на пункте,
// issues могут быть строками, urls — строкой. Всё остальное отбрасываем.
export function normalizeAuditReport(raw: any, fallbackHost = "project", now = new Date().toISOString()): AuditReport | null {
  if (!raw || typeof raw !== "object") return null
  const rawPoints = Array.isArray(raw.points) ? raw.points : Array.isArray(raw.items) ? raw.items : []
  const points: AuditPoint[] = []
  for (const rp of rawPoints) {
    if (!rp || typeof rp !== "object") continue
    const point = text(rp.point ?? rp.id ?? rp.num, 12)
    const title = text(rp.title ?? rp.name, 300)
    if (!point && !title) continue
    const severity = normalizeSeverity(rp.severity ?? rp.criticality, "medium")
    const issues: AuditIssue[] = []
    const seen = new Set<string>()
    for (const ri of Array.isArray(rp.issues) ? rp.issues : []) {
      const issue: any = typeof ri === "string" ? { title: ri } : ri
      if (!issue || typeof issue !== "object") continue
      const issueTitle = text(issue.title ?? issue.text ?? issue.problem ?? issue.name, 300)
      if (!issueTitle) continue
      const key = issueKey(point || title, issueTitle)
      if (seen.has(key)) continue
      seen.add(key)
      const urls = urlList(issue.urls ?? issue.url ?? issue.pages)
      issues.push({
        point: point || title,
        title: issueTitle,
        severity: normalizeSeverity(issue.severity ?? issue.criticality, severity),
        urls,
        fix: text(issue.fix ?? issue.recommendation ?? issue.howTo ?? issue.solution, 600),
        count: Math.max(1, Number(issue.count ?? issue.found ?? urls.length) || 1),
      })
    }
    points.push({
      point: point || title,
      title: title || point,
      checkedPages: Math.max(0, Number(rp.checkedPages ?? rp.pages ?? 0) || 0),
      summary: text(rp.summary ?? rp.verdict, 1000),
      issues,
      positive: (Array.isArray(rp.positive) ? rp.positive : []).map((p: unknown) => text(p, 300)).filter(Boolean).slice(0, 20),
    })
  }
  if (!points.length) return null
  return {
    version: 1,
    host: text(raw.host, 200) || fallbackHost,
    site: text(raw.site ?? raw.url, 300),
    generatedAt: /^\d{4}-\d{2}-\d{2}/.test(String(raw.generatedAt ?? "")) ? String(raw.generatedAt) : now,
    points,
    summary: text(raw.summary ?? raw.conclusion, 2000),
    sitemapCoverage: raw.sitemapCoverage ?? null,
  }
}

export function scoreAudit(report: AuditReport): AuditScore {
  const counts = { high: 0, medium: 0, low: 0 }
  for (const point of report.points) for (const issue of point.issues) counts[issue.severity]++
  const total = counts.high + counts.medium + counts.low
  const penalty = counts.high * 12 + counts.medium * 4 + counts.low
  const score = Math.max(0, Math.min(100, 100 - penalty))
  const gate: AuditScore["gate"] = counts.high ? "fail" : counts.medium ? "warn" : "pass"
  return { score, gate, counts, total }
}

export interface IssueDiff {
  key: string
  point: string
  title: string
  severity: Severity
}
export interface ReportDelta {
  scoreFrom: number | null
  scoreTo: number
  added: IssueDiff[]
  fixed: IssueDiff[]
  persisting: number
}

export function diffReports(prev: AuditReport | null, next: AuditReport): ReportDelta {
  const collect = (r: AuditReport) => {
    const map = new Map<string, IssueDiff>()
    for (const point of r.points) for (const issue of point.issues) map.set(issueKey(issue.point, issue.title), issue)
    return map
  }
  const before = prev ? collect(prev) : new Map<string, IssueDiff>()
  const after = collect(next)
  const added = [...after].filter(([k]) => !before.has(k)).map(([, v]) => v)
  const fixed = [...before].filter(([k]) => !after.has(k)).map(([, v]) => v)
  const persisting = [...after].filter(([k]) => before.has(k)).length
  return { scoreFrom: prev ? scoreAudit(prev).score : null, scoreTo: scoreAudit(next).score, added, fixed, persisting }
}

// ---------- История прогонов (в корне результатов, отдельно для теста/прода) ----------
export interface RunRecord {
  id: string
  host: string
  site: string
  at: string
  dir: string
  points: string[]
  score: number | null
  gate: "pass" | "warn" | "fail" | "unknown"
  counts: AuditScore["counts"] | null
  jobId?: string
  scheduled?: boolean
  depthContent?: number
  depthSpeed?: number
  semcoreMsg?: string
  semcorePath?: string
  sitemapCoverage?: any
}
export interface RunsStore { version: 1; runs: RunRecord[] }

function statePath(root: string, name: string): string {
  return join(root, name)
}
export function readRuns(root: string): RunsStore {
  try {
    const file = statePath(root, ".runs.json")
    if (!existsSync(file)) return { version: 1, runs: [] }
    const raw = JSON.parse(readFileSync(file, "utf8"))
    return { version: 1, runs: Array.isArray(raw?.runs) ? raw.runs.filter((r: any) => r && r.host && r.at) : [] }
  } catch {
    return { version: 1, runs: [] }
  }
}
export function appendRun(root: string, run: RunRecord): RunsStore {
  const store = readRuns(root)
  store.runs.push(run)
  if (store.runs.length > 1000) store.runs = store.runs.slice(-1000)
  writeJsonAtomic(statePath(root, ".runs.json"), store)
  return store
}
export function lastRun(root: string, host: string, exceptId?: string): RunRecord | null {
  const runs = readRuns(root).runs.filter((r) => r.host === host && r.id !== exceptId)
  return runs.length ? runs[runs.length - 1] : null
}

// Допустимые переходы статуса проблемы. Значение — разрешённые следующие статусы.
export const ISSUE_STATUS_TRANSITIONS: Record<IssueRecord["status"], IssueRecord["status"][]> = {
  open: ["in_progress", "fixed", "ignored"],
  in_progress: ["open", "fixed", "ignored"],
  fixed: ["open"],
  ignored: ["open"],
}

export function setIssueStatus(store: IssuesStore, host: string, id: string, status: IssueRecord["status"], note?: string, now = new Date().toISOString()): boolean {
  const rec = store.hosts[host]?.issues?.[id]
  if (!rec) return false
  if (rec.status === status) {
    rec.note = note ?? rec.note
    rec.lastSeen = now
    return true
  }
  const allowed = ISSUE_STATUS_TRANSITIONS[rec.status]
  if (!allowed || !allowed.includes(status)) return false
  rec.status = status
  rec.note = note ?? rec.note
  rec.lastSeen = now
  return true
}

// ---------- Проблемы: статусы и повторные появления ----------
export interface IssueRecord extends AuditIssue {
  id: string
  status: "open" | "in_progress" | "fixed" | "ignored"
  firstSeen: string
  lastSeen: string
  runId: string
  vanishedAt?: string
  note?: string
}
export interface IssuesStore { version: 1; hosts: Record<string, { issues: Record<string, IssueRecord> }> }

export function readIssues(root: string): IssuesStore {
  try {
    const file = statePath(root, ".issues.json")
    if (!existsSync(file)) return { version: 1, hosts: {} }
    const raw = JSON.parse(readFileSync(file, "utf8"))
    return { version: 1, hosts: raw?.hosts && typeof raw.hosts === "object" ? raw.hosts : {} }
  } catch {
    return { version: 1, hosts: {} }
  }
}
export function writeIssues(root: string, store: IssuesStore): void {
  writeJsonAtomic(statePath(root, ".issues.json"), store)
}

export function applyReport(store: IssuesStore, host: string, report: AuditReport, runId: string, now = new Date().toISOString()) {
  const bucket = (store.hosts[host] ||= { issues: {} })
  const present = new Set<string>()
  let added = 0
  let reopened = 0
  for (const point of report.points) {
    for (const issue of point.issues) {
      const id = issueKey(issue.point, issue.title)
      present.add(id)
      const existing = bucket.issues[id]
      if (!existing) {
        added++
        bucket.issues[id] = { ...issue, id, status: "open", firstSeen: now, lastSeen: now, runId }
      } else {
        existing.severity = issue.severity
        existing.urls = issue.urls
        existing.fix = issue.fix || existing.fix
        existing.count = issue.count
        existing.lastSeen = now
        existing.runId = runId
        delete existing.vanishedAt
        // Проблема вернулась после «исправлена» — это регресс, снова открываем.
        if (existing.status === "fixed") { existing.status = "open"; reopened++ }
      }
    }
  }
  let vanished = 0
  for (const rec of Object.values(bucket.issues)) {
    if (!present.has(rec.id) && !rec.vanishedAt && rec.lastSeen !== now) {
      rec.vanishedAt = now
      vanished++
    }
  }
  return { added, reopened, vanished }
}

// ---------- Настройки: пресеты, расписание, телеграм, интеграции ----------
export interface AuditPointRef { point: string; skill: string }
export interface Schedule {
  host: string
  site: string
  points: AuditPointRef[]
  everyDays: number
  hour: number
  enabled: boolean
  lastRunAt?: string
  depthContent?: number
  depthSpeed?: number
}
export interface InsightsSettings {
  version: 1
  presets: { name: string; points: AuditPointRef[] }[]
  schedules: Schedule[]
  telegram: { token: string; chatId: string }
  integrations: {
    psiKey: string
    gscToken: string
    webmasterToken: string
    metrikaToken: string
    metrikaCounter: string
    wordstatKey: string
    wordstatFolderId: string
  }
}

export const DEFAULT_SETTINGS: InsightsSettings = {
  version: 1,
  presets: [],
  schedules: [],
  telegram: { token: "", chatId: "" },
  integrations: {
    psiKey: "",
    gscToken: "",
    webmasterToken: "",
    metrikaToken: "",
    metrikaCounter: "",
    wordstatKey: "",
    wordstatFolderId: "",
  },
}

export function readSettings(root: string): InsightsSettings {
  try {
    const file = statePath(root, ".insights.json")
    if (!existsSync(file)) return structuredClone(DEFAULT_SETTINGS)
    const raw = JSON.parse(readFileSync(file, "utf8"))
    return {
      version: 1,
      presets: Array.isArray(raw?.presets) ? raw.presets.filter((p: any) => p && p.name) : [],
      schedules: Array.isArray(raw?.schedules) ? raw.schedules.filter((s: any) => s && s.site) : [],
      telegram: { ...DEFAULT_SETTINGS.telegram, ...(raw?.telegram || {}) },
      integrations: { ...DEFAULT_SETTINGS.integrations, ...(raw?.integrations || {}) },
    }
  } catch {
    return structuredClone(DEFAULT_SETTINGS)
  }
}

export function saveSettings(root: string, patch: Partial<InsightsSettings>): InsightsSettings {
  const current = readSettings(root)
  const next: InsightsSettings = {
    version: 1,
    presets: Array.isArray(patch.presets) ? patch.presets.slice(0, 50) : current.presets,
    schedules: Array.isArray(patch.schedules)
      ? patch.schedules.slice(0, 50).map((s) => ({
          ...s,
          everyDays: Math.max(1, Math.min(90, Number(s.everyDays) || 7)),
          hour: Math.max(0, Math.min(23, Number(s.hour) || 9)),
          enabled: s.enabled !== false,
          points: Array.isArray(s.points) ? s.points.filter((p) => p && p.point && p.skill) : [],
        }))
      : current.schedules,
    telegram: { ...current.telegram, ...(patch.telegram || {}) },
    integrations: { ...current.integrations, ...(patch.integrations || {}) },
  }
  writeJsonAtomic(statePath(root, ".insights.json"), next)
  return next
}

// Чистая функция: какие расписания пора запускать на момент now.
export function dueSchedules(settings: InsightsSettings, now: number): Schedule[] {
  const hour = new Date(now).getHours()
  return settings.schedules.filter((s) => {
    if (!s.enabled || !s.site || !s.points?.length) return false
    if (hour < s.hour) return false
    if (!s.lastRunAt) return true
    const last = Date.parse(s.lastRunAt)
    if (!Number.isFinite(last)) return true
    return now - last >= Math.max(1, s.everyDays) * 86_400_000
  })
}

export async function telegramNotify(
  settings: InsightsSettings,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const { token, chatId } = settings.telegram
  if (!token || !chatId) return false
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true }),
    })
    return res.ok
  } catch {
    return false
  }
}

export function formatRunMessage(host: string, run: RunRecord, delta: ReportDelta | null): string {
  const gate = run.gate === "pass" ? "✅ пройден" : run.gate === "warn" ? "⚠️ замечания" : run.gate === "fail" ? "⛔ не пройден" : "—"
  const lines = [
    `<b>SEO-аудит: ${host}</b>`,
    `Гейт: ${gate}`,
    run.score === null ? "Скор: —" : `Скор: ${run.score}/100`,
    run.counts ? `Проблем: ${run.counts.high} высоких, ${run.counts.medium} средних, ${run.counts.low} низких` : "",
  ]
  if (delta) {
    lines.push(`Новых: ${delta.added.length}, закрыто: ${delta.fixed.length}, осталось: ${delta.persisting}`)
    if (delta.scoreFrom !== null) lines.push(`Скор: ${delta.scoreFrom} → ${delta.scoreTo}`)
  }
  return lines.filter(Boolean).join("\n")
}

// ---------- Трекинг позиций (M3 из seo-factory-starter) ----------
export interface PositionRecord {
  id: string
  host: string
  site: string
  date: string
  query: string
  page: string
  position: number
  clicks: number
  impressions: number
  ctr: number
  source: "gsc" | "webmaster"
}
export interface PositionsStore { version: 1; positions: PositionRecord[] }

function positionsPath(root: string): string {
  return join(root, ".positions.json")
}
export function readPositions(root: string): PositionsStore {
  try {
    const file = positionsPath(root)
    if (!existsSync(file)) return { version: 1, positions: [] }
    const raw = JSON.parse(readFileSync(file, "utf8"))
    return { version: 1, positions: Array.isArray(raw?.positions) ? raw.positions.filter((p: any) => p && p.host && p.date && p.query) : [] }
  } catch {
    return { version: 1, positions: [] }
  }
}
export function appendPositions(root: string, positions: PositionRecord[]): PositionsStore {
  const store = readPositions(root)
  store.positions.push(...positions)
  if (store.positions.length > 5000) store.positions = store.positions.slice(-5000)
  writeJsonAtomic(positionsPath(root), store)
  return store
}
export function lastPositions(root: string, host: string, date?: string): PositionRecord[] {
  const all = readPositions(root).positions.filter((p) => p.host === host)
  if (date) return all.filter((p) => p.date === date)
  return all
}
export function positionsDelta(root: string, host: string, dateFrom: string, dateTo: string): { query: string; page: string; positionFrom: number | null; positionTo: number | null; change: number | null }[] {
  const from = lastPositions(root, host, dateFrom)
  const to = lastPositions(root, host, dateTo)
  const toMap = new Map<string, PositionRecord>()
  for (const p of to) toMap.set(`${p.query}|${p.page}`, p)
  const result: { query: string; page: string; positionFrom: number | null; positionTo: number | null; change: number | null }[] = []
  for (const p of from) {
    const cur = toMap.get(`${p.query}|${p.page}`)
    result.push({
      query: p.query,
      page: p.page,
      positionFrom: p.position,
      positionTo: cur ? cur.position : null,
      change: cur ? cur.position - p.position : null,
    })
  }
  return result
}
