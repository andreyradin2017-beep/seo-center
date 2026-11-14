import type { Plugin } from "@opencode-ai/plugin"
import { networkInterfaces, homedir } from "node:os"
import { join, resolve, relative, sep, basename, dirname } from "node:path"
import { readdirSync, statSync, lstatSync, realpathSync, readFileSync, writeFileSync, appendFileSync, chmodSync, existsSync, mkdirSync, rmSync, renameSync, statfsSync } from "node:fs"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { constantTimeEqual, createAuthToken, credentialVersion, hasGlobalAccess, hashPassword, parseAuthToken, safePath, sanitizeOwnerName, verifyPassword } from "../lib/security.ts"
import { writeJsonAtomic } from "../lib/json-store.ts"
import type { AuthInfo, AuthRole } from "../lib/security.ts"
import {
  applyReport, appendRun, appendPositions, diffReports, dueSchedules, formatRunMessage, lastPositions, normalizeAuditReport, positionsDelta, readIssues,
  readPositions, readRuns, readSettings, saveSettings, scoreAudit, setIssueStatus, telegramNotify, writeIssues,
} from "../lib/audit-store.ts"
import type { AuditReport, RunRecord } from "../lib/audit-store.ts"
import { buildJsonLd, buildRobots, buildSitemap, jsonLdTemplate, urlsFromCsv } from "../lib/generators.ts"
import { renderGeneratorsPage, renderInsightsPage } from "../lib/pages.ts"
import { gscSites, metrikaSummary, metrikaTrafficSources, metrikaGoals, metrikaComparePeriods, psiCheck, webmasterHosts, wordstatFrequency } from "../lib/integrations.ts"

const SKILL_EXTRACT = "seo-metatags-extract"
const SKILL_METATAGS = "seo-metatags"
const SKILL_WORDSTAT = "wordstat"
const SKILL_TOPICS = "seo-topics"
const SKILL_ARTICLES = "seo-articles"
const SKILL_ADRESS = "adresa-stranits"
const SKILL_DUPLICATES = "dublikaty-stranits"
const SKILL_RESPONSES = "zagolovki-otklikov-servera"
const SKILL_INDEXING = "indeksatsiya-sayta"
const SKILL_TOPOLOGY = "topologiya-ssylok"
const SKILL_SMM_GROUPS = "smm-groups"
const SKILL_MICRODATA = "mikrorazmetka"

const DEFAULT_PORT = 4180
const RESULTS_EXTS = [".csv", ".xlsx", ".xls", ".docx", ".doc", ".md", ".html"]

// Модель для всех задач SEO-центра. Задаётся явно, иначе сессия подхватывает
// глобальную модель по умолчанию (например opencode/big-pickle), которая падает
// с 403 «free tier can only be used from within OpenCode».
// Изменить: переменная окружения SEO_CENTER_MODEL=providerID/modelID.
const SEO_CENTER_MODEL = (() => {
  const raw = (process.env.SEO_CENTER_MODEL || "opencode-go/deepseek-v4.1-flash").trim()
  const i = raw.indexOf("/")
  if (i <= 0 || i === raw.length - 1) return { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" }
  return { providerID: raw.slice(0, i), modelID: raw.slice(i + 1) }
})()

// Дешёвая/бесплатная модель для «скриптовых» пунктов аудита (2.1–2.5, 3.1, 3.2, 4.1, 4.2):
// всю работу делает Python-скрипт, поэтому модель экономится без потери качества.
const SEO_CENTER_MODEL_FREE = (() => {
  const raw = (process.env.SEO_CENTER_MODEL_FREE || "opencode-go/longcat-2.5-preview-free").trim()
  const i = raw.indexOf("/")
  if (i <= 0 || i === raw.length - 1) return { providerID: "opencode-go", modelID: "longcat-2.5-preview-free" }
  return { providerID: raw.slice(0, i), modelID: raw.slice(i + 1) }
})()

// Второй бесплатный вариант — используется, если первый капризничает (каскад: free1 → free2 → flash).
const SEO_CENTER_MODEL_FREE2 = (() => {
  const raw = (process.env.SEO_CENTER_MODEL_FREE2 || "opencode-go/space-bunny-free").trim()
  const i = raw.indexOf("/")
  if (i <= 0 || i === raw.length - 1) return { providerID: "opencode-go", modelID: "space-bunny-free" }
  return { providerID: raw.slice(0, i), modelID: raw.slice(i + 1) }
})()

// Модель КОПИРАЙТЕРСКОЙ ПОЛИРОВКИ статей (второй проход после генерации).
// Генерация идёт на основной модели, полировка — на этой (по умолчанию qwen3.8-max).
// Переопределяется: SEO_CENTER_MODEL_POLISH="provider/model".
const SEO_CENTER_MODEL_POLISH = (() => {
  const raw = (process.env.SEO_CENTER_MODEL_POLISH || "opencode-go/qwen3.8-max").trim()
  const i = raw.indexOf("/")
  if (i <= 0 || i === raw.length - 1) return { providerID: "opencode-go", modelID: "qwen3.8-max" }
  return { providerID: raw.slice(0, i), modelID: raw.slice(i + 1) }
})()

// Навыки, где основную работу делает скрипт (краулинг/сбор данных), а модель
// лишь оркеструет и отчитывается — их экономно гонять на бесплатной модели.
// Список настраивается: SEO_CENTER_FREE_TOOLS="extract,wordstat,smm" (пусто — выкл).
const FREE_TOOLS = new Set(
  (process.env.SEO_CENTER_FREE_TOOLS ?? "extract,wordstat,smm")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
)

const SCRIPT_POINTS = new Set(["2.1", "2.2", "2.3", "2.4", "2.5", "3.1", "3.2", "4.1", "4.2", "5.1"])
// Соответствие «номер пункта → навык»: по нему повторяются прогоны и строятся
// расписания (в истории хранятся номера, а запуску нужны имена навыков).
const POINT_SKILLS: Record<string, string> = {
  "1.1": "adresa-stranits", "1.2": "dublikaty-stranits", "1.3": "zagolovki-otklikov-servera",
  "1.4": "indeksatsiya-sayta", "1.5": "topologiya-ssylok",
  "2.1": "tekstovyj-kontent", "2.2": "oformlenie-teksta", "2.3": "sluzhebnye-tegi",
  "2.4": "izobrazheniya", "2.5": "ishodyashchie-ssylki", "2.6": "mikrorazmetka",
  "3.1": "snippety", "3.2": "vneshnie-ssylki", "4.1": "skorost-zagruzki", "4.2": "pereboi-v-rabote",
  "5.1": "geo-aeo-audit",
}
// Очередь: после завершения free-задачи (скрипты) запускаем flash-задачу (модельные пункты + сборка).
const auditFollowups = new Map<string, {
  prompt: string; label: string; host: string; outDir: string; owner?: string
  scriptPrompt?: string; freeStage?: number; jobId?: string
  site?: string; scriptPts?: { point: string; skill: string }[]; resumeAttempts?: number
}>()

// Задачи статей, которым после генерации нужен второй проход — копирайтерская
// полировка на модели SEO_CENTER_MODEL_POLISH (Max). done=true — полировка уже
// запущена, следующее завершение помечает задачу выполненной.
const articlePolishes = new Map<string, { outDir: string; host: string; done?: boolean }>()

// Маркеры выполнения скриптовых пунктов: <outDir>/.point_<номер>_done.
// По ним плагин понимает, что первый этап оборвался, и дозапускает только
// недостающие пункты, а не весь этап заново.
function scriptMarkerPath(outDir: string, point: string): string {
  return join(outDir, `.point_${point}_done`)
}
function missingScriptPoints(outDir: string, scriptPts: { point: string; skill: string }[]): string[] {
  return scriptPts.filter((p) => !existsSync(scriptMarkerPath(outDir, p.point))).map((p) => p.point)
}
function buildScriptResumePrompt(site: string, outDir: string, missing: { point: string; skill: string }[]): string {
  const list = missing.map((p) => `- п. ${p.point} — навык ${p.skill}`).join("\n")
  return `Дозапуск первого этапа SEO-аудита: часть скриптовых пунктов не завершена (нет файла-маркера).

Сайт: ${site}
Папка результатов: ${outDir}

Не завершены:
${list}

Выполни ТОЛЬКО эти пункты — для каждого прочитай SKILL.md и выполни его скрипт. Пункты, у которых маркер ${outDir}/.point_<номер>_done уже существует, НЕ переделывай (если файлы результата на месте — просто создай маркер). После каждого выполненного пункта создавай маркер ${outDir}/.point_<номер>_done. Когда все перечисленные пункты готовы — создай ${outDir}/.scripts_done и выведи список созданных файлов.`
}

// ---------- Очередь аудитов (лимит одновременных настраивается в админке) ----------
const AUDIT_MAX_CONCURRENT = 2 // значение по умолчанию
const AUDIT_AVG_MINUTES = 15 // грубая оценка длительности одного аудита для расчёта ожидания
// Актуальные значения берутся из админ-настроек (см. adminSettings()).
function auditMaxConcurrent(): number { return adminSettings().auditMaxConcurrent }
function auditAvgMinutes(): number { return adminSettings().auditAvgMinutes }
interface AuditJob {
  id: string
  site: string
  host: string
  outDir: string
  owner: string
  label: string
  points: { point: string; skill: string }[]
  status: "queued" | "running" | "done" | "failed"
  enqueuedAt: number
  startedAt?: number
  currentTaskId?: string
  scriptPrompt: string
  modelPrompt: string
  assemblyOnlyPrompt: string
  scheduled?: boolean
  depthContent?: number
  depthSpeed?: number
  semcoreMsg?: string
  semcorePath?: string
  dryRun?: boolean
}
const auditJobs = new Map<string, AuditJob>()
let auditRunning = 0
let auditSeq = 0
function newAuditJobId(): string { return `aj${Date.now().toString(36)}_${auditSeq++}` }
function auditEtaMinutes(position: number): number {
  return Math.max(1, Math.round(((auditRunning + position) / auditMaxConcurrent()) * auditAvgMinutes()))
}
function fmtEta(min: number): string {
  if (min < 60) return `~${min} мин`
  const h = Math.floor(min / 60), m = min % 60
  return m ? `~${h} ч ${m} мин` : `~${h} ч`
}

// ---------------------------------------------------------------------------
// Персист очереди аудитов: рестарт сервиса (деплой/патч) не должен терять
// поставленные и выполняющиеся аудиты. Сохраняем задания на диск (дебаунс),
// при старте поднимаем: queued остаются в очереди, running → снова queued
// (маркеры .point_*_done позволяют дозапустить только недостающее).
// ---------------------------------------------------------------------------
const AUDIT_STATE_FILE = process.env.SEO_QUEUE_STATE_FILE
  ? String(process.env.SEO_QUEUE_STATE_FILE)
  : (process.env.SEO_RESULTS_DIR
    ? join(String(process.env.SEO_RESULTS_DIR), ".queue.json")
    : join(homedir(), ".config", "opencode", "seo-center-queue.json"))
let _queueSaveTimer: any = null
function scheduleQueueSave(): void {
  if (_queueSaveTimer) return
  _queueSaveTimer = setTimeout(() => {
    _queueSaveTimer = null
    try {
      const jobs = [...auditJobs.values()].map((j) => ({ ...j }))
      writeJsonAtomic(AUDIT_STATE_FILE, { version: 1, savedAt: new Date().toISOString(), jobs })
    } catch (e) { log("queue save failed: " + String(e)) }
  }, 1500)
  try { _queueSaveTimer.unref?.() } catch {}
}
function loadAuditQueueState(): number {
  try {
    if (!existsSync(AUDIT_STATE_FILE)) return 0
    const raw = JSON.parse(readFileSync(AUDIT_STATE_FILE, "utf8"))
    const jobs = Array.isArray(raw && raw.jobs) ? raw.jobs : []
    let n = 0
    for (const j of jobs) {
      if (!j || !j.id || !j.host || !Array.isArray(j.points)) continue
      if (auditJobs.has(j.id)) continue
      const job: AuditJob = { ...j, status: "queued", startedAt: undefined, currentTaskId: undefined }
      auditJobs.set(job.id, job)
      n++
    }
    if (n) log(`queue restored: ${n} заданий из seo-center-queue.json`)
    return n
  } catch (e) { log("queue load failed: " + String(e)); return 0 }
}


type TaskStatus = "running" | "done" | "error" | "cancelled"

interface TaskState {
  id: string
  tool: string
  label: string
  status: TaskStatus
  message: string
  host?: string
  outDir?: string
  tab?: string
  sessionID?: string
  // Владелец задачи (имя сотрудника или "admin"). Не-админам показываются
  // только их задачи; админ видит все.
  owner?: string
  // Привязка к заданию очереди аудита (для учёта занятости и старта следующего).
  auditJobId?: string
  startedAt: number
  updatedAt: number
  // Этапный прогресс: текущий этап (1-based), всего этапов и вычисленный процент.
  stage?: number
  stagesTotal?: number
  pct?: number
  // Для выбора бесплатной модели и отката на платную при сбое.
  lastPrompt?: string
  usedFree?: boolean
  escalated?: boolean
}

// Этапы по каждому навыку — прогресс в UI привязан к реальным шагам работы.
// Ключи — короткие имена инструментов, которые передаются в newTask().
// Модель сообщает текущий этап маркером [[stage:N/M]] в тексте ответа; плагин
// пересчитывает процент как N/M*100.
const SKILL_STAGES: Record<string, string[]> = {
  "topics": [
    "Кэш и sitemap",
    "Бренд-контекст и существующие статьи",
    "Конкуренты и уникальность",
    "Генерация тем и семядро",
    "Сбор частотностей Wordstat",
    "Итоговая таблица (XLSX/CSV)",
  ],
  "extract": [
    "Сбор списка URL",
    "Загрузка и парсинг страниц",
    "Фильтрация по статусам",
    "Сборка таблицы и сохранение",
  ],
  "metatags": [
    "Сбор URL и текущих метатегов",
    "Определение целевых страниц",
    "Анализ кластеров",
    "Составление title/description",
    "Сохранение XLSX/CSV",
  ],
  "wordstat": [
    "Подготовка сессии",
    "Сбор частотностей",
    "Сохранение CSV",
  ],
  "articles": [
    "Бренд-контекст",
    "Подготовка тем",
    "Написание материалов",
    "Сохранение DOCX/JSON",
  ],
  "audit": [
    "Обход сайта",
    "Проверка адресации",
    "Формирование .docx",
  ],
  "duplicates": [
    "Обход сайта",
    "Поиск дубликатов и сравнение контента",
    "Формирование .docx",
  ],
  "responses": [
    "Обход перелинковки",
    "Проверка откликов сервера",
    "Формирование .docx",
  ],
  "indexing": [
    "Загрузка robots.txt/sitemap.xml/llms.txt",
    "Анализ ошибок и полноты",
    "Формирование .docx",
  ],
  "topology": [
    "Обход сайта и сбор ссылок",
    "Анализ топологии и вложенности",
    "Формирование .docx",
  ],
  "smm": [
    "Авторизация и подготовка площадок",
    "Сбор постов по группам за период",
    "Сбор статистики по постам",
    "Формирование XLSX",
  ],
  "microdata": [
    "Сбор списка URL и обход сайта",
    "Извлечение Schema.org и OpenGraph",
    "Анализ ошибок полей и синтаксиса",
    "Подбор отсутствующих типов",
    "Формирование XLSX",
  ],
  "auditfull": [
    "Обход сайта и запуск навыков по пунктам",
    "Сборка единого документа",
    "Сохранение .docx",
  ],
}

// Разбор маркеров этапов из текста модели: [[stage:N/M]] или [[этап:N/M]].
function parseStageMarkers(text: string): { stage: number; total: number } | null {
  const re = /\[\[\s*(?:stage|этап)\s*:\s*(\d+)\s*\/\s*(\d+)\s*\]\]/i
  const m = re.exec(String(text || ""))
  if (!m) return null
  const stage = parseInt(m[1], 10)
  const total = parseInt(m[2], 10)
  if (!stage || !total || stage < 1 || total < 1) return null
  return { stage: Math.min(stage, total), total }
}

const tasksStore = new Map<string, TaskState>()
let taskSeq = 0

// Задачи одного проекта (определяется по URL/хосту) выполняются в отдельной сессии.
// projectSessions: ключ проекта (хост) -> id сессии opencode.
// taskSessions/sessionTasks: связь задача <-> сессия для маршрутизации событий.
const projectSessions = new Map<string, string>()
const taskSessions = new Map<string, string>()
const sessionTasks = new Map<string, string>()

// Нормализация ключа проекта из URL/хоста.
function projectKeyFrom(input?: string): string {
  const raw = String(input || "").trim()
  if (!raw) return "project"
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).host || "project"
  } catch {}
  return raw.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase() || "project"
}

function newTask(tool: string, label: string): TaskState {
  const id = `t${Date.now().toString(36)}_${taskSeq++}`
  const stages = SKILL_STAGES[tool] || []
  const task: TaskState = {
    id,
    tool,
    label,
    status: "running",
    message: "Задание отправлено в opencode…",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    stage: 0,
    stagesTotal: stages.length,
    pct: 0,
  }
  tasksStore.set(id, task)
  try { pushHistory({ at: nowIso(), user: "", tool, site: "", status: "running", taskId: id }) } catch {}
  if (tasksStore.size > 60) {
    const sorted = [...tasksStore.values()].sort((a, b) => b.startedAt - a.startedAt)
    for (const t of sorted.slice(60)) tasksStore.delete(t.id)
  }
  return task
}

// Обновление этапного прогресса: этап N из M => процент N/M*100.
function setTaskStage(id: string, stage: number, total: number, message?: string): void {
  const t = tasksStore.get(id)
  if (!t) return
  const safeTotal = total > 0 ? total : (t.stagesTotal || 0)
  if (!safeTotal) return
  const safeStage = Math.max(1, Math.min(stage, safeTotal))
  const pct = Math.round((safeStage / safeTotal) * 100)
  const stages = SKILL_STAGES[t.tool] || []
  const name = stages[safeStage - 1]
  updateTask(id, {
    stage: safeStage,
    stagesTotal: safeTotal,
    pct,
    message: message || (name ? `Этап ${safeStage}/${safeTotal}: ${name}` : `Этап ${safeStage}/${safeTotal}`),
  })
}

  function updateTask(id: string, patch: Partial<TaskState>): void {
    const t = tasksStore.get(id)
    if (!t) return
    Object.assign(t, patch, { updatedAt: Date.now() })
    if (patch.status === "done" || patch.status === "error" || patch.status === "cancelled") {
      try {
        updateHistory(id, { status: patch.status, user: t.owner || "", site: t.host || "", tool: t.tool })
      } catch {}
    }
  }

function runningTasksOrdered(): TaskState[] {
  return [...tasksStore.values()]
    .filter((t) => t.status === "running")
    .sort((a, b) => a.startedAt - b.startedAt)
}

// Определяет задачу по id сессии (для маршрутизации событий opencode).
function taskForSession(sid?: string): TaskState | undefined {
  if (sid) {
    const tid = sessionTasks.get(sid)
    if (tid) {
      const t = tasksStore.get(tid)
      if (t) return t
    }
    // Сессия известна, но не наша задача (например, чат пользователя или
    // другой проект) — событие игнорируем, не приписываем случайной задаче.
    return undefined
  }
  // Событие без sessionID — относим к первой активной задаче (как раньше).
  return runningTasksOrdered()[0]
}

function errorText(err: unknown): string {
  try {
    const e = err as any
    if (e?.data?.message) return String(e.data.message)
    if (e?.message) return String(e.message)
    if (e?.name) return String(e.name)
  } catch {}
  return "Неизвестная ошибка"
}

// Адрес прослушивания панели. По умолчанию 0.0.0.0 (доступ по локальной сети).
// Для максимальной защиты можно слушать только localhost: SEO_UI_BIND=127.0.0.1.
const BIND_ADDRESS = (process.env.SEO_UI_BIND || "0.0.0.0").trim() || "0.0.0.0"

// Прикрепляем IP клиента к объекту запроса (не через заголовок, чтобы его нельзя
// было подделать). Используется allowlist'ом и журналом аудита.
function attachClientIp(request: Request, ip: string) {
  try {
    ;(request as any).__clientIp = ip || ""
  } catch {}
  return request
}

async function serveHttp(port: number, handler: (req: Request) => Promise<Response>) {
  return await new Promise<{ port: number; stop: () => void }>((resolveServer, reject) => {
    const nodeServer = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = []
        const method = incoming.method || "GET"
        const maxBodyBytes = 55 * 1024 * 1024
        const declaredLength = Number(incoming.headers["content-length"] || 0)
        if (declaredLength > maxBodyBytes) {
          outgoing.statusCode = 413
          outgoing.end("Request body too large")
          incoming.resume()
          return
        }
        let bodyBytes = 0
        for await (const chunk of incoming) {
          const buffer = Buffer.from(chunk)
          bodyBytes += buffer.length
          if (bodyBytes > maxBodyBytes) {
            outgoing.statusCode = 413
            outgoing.end("Request body too large")
            incoming.resume()
            return
          }
          chunks.push(buffer)
        }
        const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks)
        const host = incoming.headers.host || `localhost:${port}`
        const request = new Request(`http://${host}${incoming.url || "/"}`, {
          method,
          headers: incoming.headers as Record<string, string>,
          body,
        })
        attachClientIp(request, incoming.socket?.remoteAddress || "")
        const response = await handler(request)
        outgoing.statusCode = response.status
        response.headers.forEach((value, key) => outgoing.setHeader(key, value))
        outgoing.end(Buffer.from(await response.arrayBuffer()))
      } catch (error) {
        console.error("[seo-ui] HTTP request failed:", error)
        outgoing.statusCode = 500
        outgoing.end("Internal Server Error")
      }
    })
    nodeServer.once("error", reject)
    nodeServer.listen(port, BIND_ADDRESS, () => {
      resolveServer({ port, stop: () => nodeServer.close() })
    })
  })
}

async function startServer(port: number, handler: (req: Request) => Promise<Response>) {
  const bun = (globalThis as any).Bun
  if (bun?.serve) {
    return bun.serve({
      hostname: BIND_ADDRESS,
      port,
      fetch: (request: Request, server: any) => {
        let ip = ""
        try {
          ip = server?.requestIP?.(request)?.address || ""
        } catch {}
        attachClientIp(request, ip)
        return handler(request)
      },
    })
  }
  return await serveHttp(port, handler)
}

// Маркер приложения — по нему понимаем, что на порту уже крутится наша SEO-панель
// (например, другая копия opencode), а не посторонний сервис.
const UI_APP_MARKER = "seo-center"

async function probeSeoPanel(port: number): Promise<boolean> {
  // 1) Сначала /api/health (новые версии плагина отдают app-маркер).
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 1500)
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal })
    clearTimeout(t)
    if (res.status === 200) {
      const j = await res.json().catch(() => null)
      if (j && j.app === UI_APP_MARKER) return true
    }
  } catch {}
  // 2) Fallback: проверить заголовок главной страницы (совместимость со старыми копиями).
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 1500)
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal })
    clearTimeout(t)
    const txt = await res.text().catch(() => "")
    return /SEO-центр|seo-center|SEO-инструменты/i.test(txt.slice(0, 4000))
  } catch {
    return false
  }
}

function log(msg: string) {
  console.log(`[seo-ui] ${msg}`)
}

// ---------------------------------------------------------------------------
// Авторизация веб-панели (cookie + пароль).
// Пароли задаются через окружение или существующий auth-файл. Небезопасных
// паролей по умолчанию больше нет. Отключить: SEO_UI_AUTH=0.
// ---------------------------------------------------------------------------
const AUTH_FILE = join(homedir(), ".config", "opencode", "seo-center-auth.json")
const AUTH_COOKIE = "seo_auth"

// Пароль администратора (видит ВСЕ проекты и документы): env или auth-файл.
function resolveAdminPassword(): string {
  if (process.env.SEO_UI_AUTH === "0") return ""
  if (process.env.SEO_UI_ADMIN_PASSWORD) return process.env.SEO_UI_ADMIN_PASSWORD
  try {
    if (existsSync(AUTH_FILE)) {
      const j = JSON.parse(readFileSync(AUTH_FILE, "utf8"))
      if (j?.admin_password && String(j.admin_password) !== "melnikov-admin") return String(j.admin_password)
    }
  } catch {}
  return ""
}

const ADMIN_PASSWORD = resolveAdminPassword()
// Отсутствие пароля не должно превращать защищённую панель в открытую.
const AUTH_ENABLED = false

// IT-доступ (супер-админ): секрет из SEO_UI_IT_PASSWORD либо scrypt-хеш
// it_password_hash в auth-файле. Фиксированных паролей в коде нет.
const IT_ADMIN_NAME = "melnikov"
function resolveItCredential(): string {
  if (process.env.SEO_UI_AUTH === "0") return ""
  const direct = (process.env.SEO_UI_IT_PASSWORD || "").trim()
  if (direct) return direct
  try {
    if (existsSync(AUTH_FILE)) {
      const j = JSON.parse(readFileSync(AUTH_FILE, "utf8"))
      if (typeof j?.it_password_hash === "string" && j.it_password_hash.startsWith("scrypt$")) return j.it_password_hash
      if (typeof j?.it_password === "string" && j.it_password) return hashPassword(j.it_password)
    }
  } catch {}
  return ""
}
const IT_ADMIN_CREDENTIAL = resolveItCredential()
function verifyItLogin(password: string): boolean {
  if (!IT_ADMIN_CREDENTIAL) return false
  return IT_ADMIN_CREDENTIAL.startsWith("scrypt$")
    ? verifyPassword(password, IT_ADMIN_CREDENTIAL)
    : constantTimeEqual(password, IT_ADMIN_CREDENTIAL)
}

// ---------------------------------------------------------------------------
// Админ-панель: пользователи, настройки сервиса и журнал запусков.
// Хранилище — ~/.config/opencode/seo-center-admin.json. При первом запуске
// пользователи засеиваются из legacy-паролей (admin + общий пароль сотрудников).
// ---------------------------------------------------------------------------
const ADMIN_FILE = join(homedir(), ".config", "opencode", "seo-center-admin.json")
const HISTORY_MAX = 500

interface AdminUser {
  name: string
  role: AuthRole
  password: string
  active: boolean
  createdAt: string
  lastLoginAt?: string
  lastLoginIp?: string
  logins?: number
}

interface AdminSettings {
  auditMaxConcurrent: number
  auditAvgMinutes: number
  resultsRetentionDays: number
  authEnabled: boolean
  modelMain: string
  modelFree: string
  modelFree2: string
  freeTools: string
}

interface AdminHistoryEntry {
  at: string
  user: string
  tool: string
  site?: string
  status: string
  taskId?: string
  jobId?: string
}

interface AdminStore {
  version: number
  settings: Partial<AdminSettings>
  users: AdminUser[]
  history: AdminHistoryEntry[]
  updatedAt?: string
}

function nowIso(): string { return new Date().toISOString() }

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = parseInt(String(v), 10)
  if (isNaN(n)) return def
  return Math.max(min, Math.min(max, n))
}

function seedAdminUsers(): AdminUser[] {
  const users: AdminUser[] = []
  if (ADMIN_PASSWORD) users.push({ name: "admin", role: "admin", password: ADMIN_PASSWORD, active: true, createdAt: nowIso() })
  return users
}

let adminStoreCache: AdminStore | null = null

function readAdminStore(force = false): AdminStore {
  if (adminStoreCache && !force) return adminStoreCache
  let store: AdminStore = { version: 1, settings: {}, users: [], history: [] }
  try {
    if (existsSync(ADMIN_FILE)) {
      const raw = JSON.parse(readFileSync(ADMIN_FILE, "utf8"))
      if (raw && typeof raw === "object") store = { ...store, ...raw }
    }
  } catch (e) { log("admin store read failed: " + String(e)) }
  if (!Array.isArray(store.users)) store.users = []
  if (!store.settings || typeof store.settings !== "object") store.settings = {}
  if (!Array.isArray(store.history)) store.history = []
  store.users = store.users.filter((u) => u && typeof u.name === "string")
  // Пароли хранятся в открытом виде (решение владельца) — их нужно видеть,
  // чтобы выдавать сотрудникам. Известные пароли по умолчанию удаляем.
  const before = store.users.length
  store.users = store.users.filter((u) => !(normalizeUserName(u.name) === "promo" && u.password === "promo") && !(normalizeUserName(u.name) === "admin" && u.password === "melnikov-admin"))
  adminStoreCache = store
  if (store.users.length !== before) {
    try { writeAdminStore() } catch {}
  }
  return store
}

function writeAdminStore(): void {
  const store = readAdminStore()
  store.updatedAt = nowIso()
  try {
    writeJsonAtomic(ADMIN_FILE, store)
  } catch (e) {
    log("admin store write failed: " + String(e))
  }
}

function adminSettings(): AdminSettings {
  const s = readAdminStore().settings || {}
  return {
    auditMaxConcurrent: clampInt(s.auditMaxConcurrent, 1, 20, 2),
    auditAvgMinutes: clampInt(s.auditAvgMinutes, 1, 600, 15),
    resultsRetentionDays: clampInt(s.resultsRetentionDays, 0, 3650, 0),
    authEnabled: AUTH_ENABLED,
    modelMain: String(s.modelMain || "").trim(),
    modelFree: String(s.modelFree || "").trim(),
    modelFree2: String(s.modelFree2 || "").trim(),
    freeTools: s.freeTools === undefined ? "" : String(s.freeTools),
  }
}

function saveAdminSettings(patch: Partial<AdminSettings>): AdminSettings {
  const store = readAdminStore()
  store.settings = { ...store.settings, ...patch }
  writeAdminStore()
  return adminSettings()
}

function authEnabled(): boolean { return AUTH_ENABLED }

function normalizeUserName(raw: string): string { return sanitizeOwnerName(raw) }

function findAdminUser(name: string): AdminUser | undefined {
  const n = normalizeUserName(name)
  if (!n) return undefined
  return readAdminStore().users.find((u) => normalizeUserName(u.name) === n)
}

function verifyAdminUser(name: string, password: string): AdminUser | null {
  const u = findAdminUser(name)
  if (!u || !u.active) return null
  return constantTimeEqual(password, String(u.password || "")) ? u : null
}

// Пароль возвращается администратору как есть (нужно выдавать сотрудникам).
function publicAdminUser(user: AdminUser): AdminUser { return user }

function upsertAdminUser(input: { name: string; role?: AuthRole; password?: string; active?: boolean; originalName?: string }): AdminUser {
  const store = readAdminStore()
  const name = normalizeUserName(input.name)
  if (!name) throw new Error("Пустое имя пользователя")
  const orig = input.originalName ? normalizeUserName(input.originalName) : name
  let u = store.users.find((x) => normalizeUserName(x.name) === orig)
  if (!u) {
    const pass = String(input.password || "")
    if (!pass) throw new Error("Для нового пользователя нужно указать пароль")
    u = { name, role: input.role || "user", password: pass, active: input.active !== false, createdAt: nowIso() }
    store.users.push(u)
  } else {
    const oldRole = u.role
    u.name = name
    if (input.role) u.role = input.role
    if (input.active !== undefined) u.active = input.active
    if (input.password) u.password = String(input.password)
    // Нельзя оставить систему без активного администратора.
    if (oldRole === "admin" && u.role !== "admin") {
      const admins = store.users.filter((x) => x.role === "admin" && x.active)
      if (admins.length === 0) u.role = "admin"
    }
  }
  writeAdminStore()
  return u
}

function removeAdminUser(name: string): { ok: boolean; error?: string } {
  const store = readAdminStore()
  const n = normalizeUserName(name)
  const target = store.users.find((u) => normalizeUserName(u.name) === n)
  if (!target) return { ok: false, error: "Пользователь не найден" }
  const admins = store.users.filter((u) => u.role === "admin" && u.active)
  if (target.role === "admin" && admins.length <= 1) return { ok: false, error: "Нельзя удалить последнего администратора" }
  store.users = store.users.filter((u) => normalizeUserName(u.name) !== n)
  writeAdminStore()
  return { ok: true }
}

function recordAdminLogin(name: string, ip: string): void {
  const n = normalizeUserName(name)
  const store = readAdminStore()
  const u = store.users.find((x) => normalizeUserName(x.name) === n)
  if (!u) return
  u.lastLoginAt = nowIso()
  u.lastLoginIp = ip
  u.logins = (u.logins || 0) + 1
  writeAdminStore()
}

function pushHistory(entry: AdminHistoryEntry): void {
  const store = readAdminStore()
  store.history.unshift(entry)
  if (store.history.length > HISTORY_MAX) store.history.length = HISTORY_MAX
  writeAdminStore()
}

function updateHistory(taskId: string, patch: Partial<AdminHistoryEntry>): void {
  const store = readAdminStore()
  const e = store.history.find((h) => h.taskId === taskId)
  if (!e) return
  Object.assign(e, patch)
  writeAdminStore()
}

// Разбор «provider/model» из строки модели.
function parseModel(raw: string, def: { providerID: string; modelID: string }): { providerID: string; modelID: string } {
  const v = String(raw || "").trim()
  const i = v.indexOf("/")
  if (i <= 0 || i === v.length - 1) return def
  return { providerID: v.slice(0, i), modelID: v.slice(i + 1) }
}

function currentMainModel() {
  return parseModel(adminSettings().modelMain || process.env.SEO_CENTER_MODEL || "opencode-go/deepseek-v4.1-flash", { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" })
}
function currentFreeModel() {
  return parseModel(adminSettings().modelFree || process.env.SEO_CENTER_MODEL_FREE || "opencode-go/longcat-2.5-preview-free", { providerID: "opencode-go", modelID: "longcat-2.5-preview-free" })
}
function currentFree2Model() {
  return parseModel(adminSettings().modelFree2 || process.env.SEO_CENTER_MODEL_FREE2 || "opencode-go/space-bunny-free", { providerID: "opencode-go", modelID: "space-bunny-free" })
}
function currentFreeTools(): Set<string> {
  const s = adminSettings()
  const raw = s.freeTools !== "" ? s.freeTools : (process.env.SEO_CENTER_FREE_TOOLS ?? "extract,wordstat,smm")
  return new Set(raw.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean))
}

function resolveAuthSecret(): string {
  try {
    const stored = existsSync(AUTH_FILE) ? JSON.parse(readFileSync(AUTH_FILE, "utf8")) : {}
    if (typeof stored.session_secret === "string" && stored.session_secret.length >= 40) {
      chmodSync(AUTH_FILE, 0o600)
      return stored.session_secret
    }
    const secret = randomBytes(32).toString("base64url")
    mkdirSync(dirname(AUTH_FILE), { recursive: true })
    writeFileSync(AUTH_FILE, JSON.stringify({ ...stored, session_secret: secret }, null, 2), { mode: 0o600 })
    chmodSync(AUTH_FILE, 0o600)
    return secret
  } catch (e) {
    log("не удалось сохранить секрет сессии; cookie будут сброшены при перезапуске: " + String(e))
    return randomBytes(32).toString("base64url")
  }
}

let authSecret: string | null = null
function getAuthSecret(): string {
  authSecret ??= resolveAuthSecret()
  return authSecret
}

// Читает подписанную cookie авторизации. null — доступа нет.
function getAuth(req: Request): AuthInfo | null {
  if (!authEnabled()) return { role: "admin", uid: "admin" }
  const cookie = req.headers.get("cookie") || ""
  const m = new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`).exec(cookie)
  if (!m) return null
  const decoded = parseAuthToken(m[1], getAuthSecret())
  if (!decoded) return null
  if (decoded.role === "it" && decoded.uid === IT_ADMIN_NAME && IT_ADMIN_CREDENTIAL) {
    return decoded.sessionVersion === credentialVersion(getAuthSecret(), IT_ADMIN_CREDENTIAL) ? decoded : null
  }
  const user = findAdminUser(decoded.uid)
  return user?.active && user.role === decoded.role ? { role: user.role, uid: user.name } : null
}

function authCredential(auth: AuthInfo): string {
  if (auth.role === "it" && auth.uid === IT_ADMIN_NAME && IT_ADMIN_CREDENTIAL) return IT_ADMIN_CREDENTIAL
  const user = findAdminUser(auth.uid)
  return user?.active && user.role === auth.role ? String(user.password || "") : ""
}

function isAuthed(req: Request): boolean {
  return !!getAuth(req)
}

// ---------------------------------------------------------------------------
// Защита периметра: allowlist по IP, журнал аудита, анти-брутфорс и заголовки.
// Всё опционально и по умолчанию повторяет прежнее поведение, кроме аудита и
// заголовков. Allowlist включается переменной SEO_UI_ALLOW_IPS (список через
// запятую): точный IP, префикс со «*» (192.168.0.*) или CIDR (192.168.0.0/24).
// ---------------------------------------------------------------------------
const ALLOW_IPS = (process.env.SEO_UI_ALLOW_IPS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

const AUDIT_LOG = join(homedir(), ".config", "opencode", "seo-center-audit.log")

function normalizeIp(ip: string): string {
  let v = (ip || "").trim()
  if (v.startsWith("::ffff:")) v = v.slice(7)
  if (v === "::1") return "127.0.0.1"
  return v
}

function ipToInt(ip: string): number | null {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null
    const v = parseInt(p, 10)
    if (v < 0 || v > 255) return null
    n = (n << 8) | v
  }
  return n >>> 0
}

function ipMatches(ip: string, rule: string): boolean {
  const r = rule.trim()
  if (!r) return false
  if (r === "*") return true
  if (r.includes("/")) {
    const [net, bitsStr] = r.split("/")
    const bits = parseInt(bitsStr, 10)
    const int = ipToInt(ip)
    const netInt = ipToInt(net)
    if (int == null || netInt == null || !Number.isFinite(bits) || bits < 0 || bits > 32) return false
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (int & mask) === (netInt & mask)
  }
  if (r.endsWith("*")) return ip.startsWith(r.slice(0, -1))
  return r === ip
}

function ipAllowed(ip: string): boolean {
  if (!ALLOW_IPS.length) return true
  const nip = normalizeIp(ip)
  // Локальные проверки состояния панели (health/пробинг) всегда разрешены.
  if (nip === "127.0.0.1" || nip === "::1") return true
  return ALLOW_IPS.some((rule) => ipMatches(nip, rule))
}

function clientIpOf(req: Request): string {
  return normalizeIp((req as any).__clientIp || "")
}

const AUDIT_CHMOD_DONE = { done: false }
const AUDIT_LOG_MAX_BYTES = 2 * 1024 * 1024 // 2 МБ на файл
const AUDIT_LOG_KEEP = 3 // хранить до .3 (ротация .1 … .3)

// Ротация журнала аудита: при превышении размера сдвигаем .2→.3, .1→.2,
// текущий→.1, самый старый удаляем. Не даёт журналу расти бесконечно.
function rotateAuditLogIfNeeded(): void {
  try {
    if (!existsSync(AUDIT_LOG)) return
    const st = statSync(AUDIT_LOG)
    if (st.size < AUDIT_LOG_MAX_BYTES) return
    for (let i = AUDIT_LOG_KEEP; i >= 1; i--) {
      const from = `${AUDIT_LOG}.${i}`
      const to = `${AUDIT_LOG}.${i + 1}`
      if (existsSync(from)) {
        try { rmSync(to, { force: true }) } catch {}
        try { renameSync(from, to) } catch {}
      }
    }
    try { renameSync(AUDIT_LOG, `${AUDIT_LOG}.1`) } catch {}
    AUDIT_CHMOD_DONE.done = false
  } catch {}
}

function auditLog(line: string) {
  try {
    const dir = dirname(AUDIT_LOG)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    rotateAuditLogIfNeeded()
    appendFileSync(AUDIT_LOG, `${new Date().toISOString()} ${line}\n`)
    if (!AUDIT_CHMOD_DONE.done) {
      try {
        chmodSync(AUDIT_LOG, 0o600)
      } catch {}
      AUDIT_CHMOD_DONE.done = true
    }
  } catch {}
}

// Очистка журнала (админка): удаляем текущий и все ротации.
function clearAuditLog(): number {
  let removed = 0
  const targets = [AUDIT_LOG, `${AUDIT_LOG}.1`, `${AUDIT_LOG}.2`, `${AUDIT_LOG}.3`, `${AUDIT_LOG}.4`]
  for (const f of targets) {
    try { if (existsSync(f)) { rmSync(f, { force: true }); removed++ } } catch {}
  }
  AUDIT_CHMOD_DONE.done = false
  return removed
}

function auditLogFiles(): { name: string; size: number; mtime: number }[] {
  const out: { name: string; size: number; mtime: number }[] = []
  const targets = [AUDIT_LOG, `${AUDIT_LOG}.1`, `${AUDIT_LOG}.2`, `${AUDIT_LOG}.3`, `${AUDIT_LOG}.4`]
  for (const f of targets) {
    try {
      if (!existsSync(f)) continue
      const st = statSync(f)
      out.push({ name: basename(f), size: st.size, mtime: Math.round(st.mtimeMs) })
    } catch {}
  }
  return out
}

// Анти-брутфорс: не более LOGIN_MAX неудачных входов с одного IP за окно.
const LOGIN_MAX = 10
const LOGIN_WINDOW_MS = 10 * 60 * 1000
const loginFails = new Map<string, { count: number; first: number }>()
function loginBlocked(ip: string): boolean {
  const rec = loginFails.get(ip)
  if (!rec) return false
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) {
    loginFails.delete(ip)
    return false
  }
  return rec.count >= LOGIN_MAX
}
function loginFail(ip: string) {
  const now = Date.now()
  const rec = loginFails.get(ip)
  if (!rec || now - rec.first > LOGIN_WINDOW_MS) loginFails.set(ip, { count: 1, first: now })
  else rec.count += 1
}

function secureResponse(res: Response): Response {
  const headers = new Headers(res.headers)
  headers.set("X-Content-Type-Options", "nosniff")
  headers.set("X-Frame-Options", "DENY")
  headers.set("Referrer-Policy", "no-referrer")
  headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive")
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store")
  if (!headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'")
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

function withSecurity(handler: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => secureResponse(await handler(req))
}

function buildLoginHtml(error?: string): string {
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SEO-центр — вход</title>
<style>
  :root{--bg:#0f1117;--panel:#171a23;--border:#2a2f3f;--text:#e6e9f0;--muted:#9aa3b2;--accent:#4f8cff;--danger:#ff5c6c;}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .box{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:30px 28px;width:100%;max-width:380px}
  h1{font-size:20px;background:linear-gradient(90deg,var(--accent),#7c5cff);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:6px}
  p{color:var(--muted);font-size:13px;margin-bottom:18px}
  input{width:100%;padding:12px 14px;background:#1e2230;border:1px solid var(--border);border-radius:9px;color:var(--text);font-size:14px;outline:none;margin-bottom:14px}
  input:focus{border-color:var(--accent)}
  button{width:100%;padding:13px;border:none;border-radius:9px;background:linear-gradient(90deg,var(--accent),#7c5cff);color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  button:hover{filter:brightness(1.08)}
  .err{background:rgba(255,92,108,.12);border:1px solid rgba(255,92,108,.4);color:var(--danger);padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:14px}
</style></head>
<body><div class="box">
  <h1>SEO-центр</h1>
  <p>Укажите своё имя входа — по нему будут показаны только ваши результаты.</p>
  ${error ? `<div class="err">${error}</div>` : ""}
  <form method="POST" action="/login">
    <input type="text" name="username" placeholder="Ваше имя входа (например, ivan)" autocomplete="username">
    <input type="password" name="password" placeholder="Пароль" autofocus autocomplete="current-password">
    <button type="submit">Войти</button>
  </form>
</div></body></html>`
}

const WORDSTAT_REGIONS_FALLBACK: { id: number; name: string }[] = [
  { id: 0, name: "Москва и область" },
  { id: 1, name: "Москва" },
  { id: 2, name: "Санкт-Петербург" },
  { id: 3, name: "Краснодарский край" },
  { id: 4, name: "Нижегородская область" },
  { id: 5, name: "Новосибирская область" },
  { id: 6, name: "Республика Татарстан" },
  { id: 7, name: "Ростовская область" },
  { id: 8, name: "Самарская область" },
  { id: 9, name: "Свердловская область" },
  { id: 10, name: "Все регионы" },
]

async function fetchWordstatRegions(): Promise<{ id: number; name: string }[]> {
  try {
    const res = await fetch("https://wordstat.yandex.ru/", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    })
    const html = await res.text()

    const ids: number[] = []
    const mIds = html.match(/"acceptableRegionValues":\[[^\]]*\]/)
    if (mIds) {
      for (const raw of mIds[0].slice(mIds[0].indexOf("[") + 1, mIds[0].lastIndexOf("]")).split(",")) {
        const n = Number(raw.replace(/[^0-9]/g, ""))
        if (n && !ids.includes(n)) ids.push(n)
      }
    }

    const matcher: Record<string, string> = {}
    const mMatcher = html.match(/"idLabelsMatcher":\{[^}]*\}/)
    if (mMatcher) {
      const inner = mMatcher[0].slice(mMatcher[0].indexOf("{") + 1, mMatcher[0].lastIndexOf("}"))
      const re = /"(\d+)":"((?:[^"\\]|\\.)*)"/g
      let mm: RegExpExecArray | null
      while ((mm = re.exec(inner))) matcher[mm[1]] = mm[2]
    }

    const regions: { id: number; name: string }[] = []
    for (const id of ids) {
      const name = (matcher[String(id)] || "").trim()
      if (name && !regions.some((r) => r.name === name)) regions.push({ id, name })
    }
    if (regions.length) return regions
  } catch (e) {
    log("wordstat regions fetch failed: " + String(e))
  }
  return WORDSTAT_REGIONS_FALLBACK
}

function getLanIp(): string | null {
  try {
    const ifaces = networkInterfaces()
    for (const list of Object.values(ifaces)) {
      if (!list) continue
      for (const info of list) {
        if (info.family === "IPv4" && !info.internal) {
          const ip = info.address
          if (ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("172.")) {
            return ip
          }
        }
      }
    }
    for (const list of Object.values(ifaces)) {
      if (!list) continue
      for (const info of list) {
        if (info.family === "IPv4" && !info.internal) return info.address
      }
    }
  } catch {}
  return null
}

function buildUiHtml(port: number, lanIp: string | null, auth?: AuthInfo | null): string {
  const lanUrl = lanIp ? `http://${lanIp}:${port}` : `http://localhost:${port}`
  const isTest = (process.env.SEO_CENTER_ENV || "").trim().toLowerCase() === "test"
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SEO-инструменты — запуск навыков</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%234f8cff'/%3E%3Cstop offset='1' stop-color='%237c5cff'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='32' height='32' rx='7' fill='url(%23g)'/%3E%3Ccircle cx='12' cy='13' r='5.5' fill='none' stroke='white' stroke-width='2.4'/%3E%3Cpath d='M16.5 17.5 L21 22' stroke='white' stroke-width='2.8' stroke-linecap='round'/%3E%3C/svg%3E">
<style>
  :root {
    --bg: #0f1117;
    --panel: #171a23;
    --panel-2: #1e2230;
    --border: #2a2f3f;
    --text: #e6e9f0;
    --muted: #9aa3b2;
    --accent: #4f8cff;
    --accent-2: #7c5cff;
    --green: #35c48b;
    --danger: #ff5c6c;
    --radius: 12px;
    --shadow: rgba(0,0,0,.22);
    --code-bg: rgba(255,255,255,.07);
    color-scheme: dark;
  }
  html[data-theme="light"] {
    --bg: #f4f6fb;
    --panel: #ffffff;
    --panel-2: #edf0f7;
    --border: #d7dce8;
    --text: #1b1f2a;
    --muted: #5c6678;
    --accent: #3b74e0;
    --accent-2: #6d4ce0;
    --green: #1f9e6a;
    --danger: #d93648;
    --shadow: rgba(20,30,60,.14);
    --code-bg: rgba(20,30,60,.07);
    color-scheme: light;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 40px 20px;
    display: flex;
    justify-content: center;
    transition: background-color .2s ease, color .2s ease;
  }
  html[data-theme="light"] .watermark { opacity: .45; }
  html[data-theme="light"] select:not(.project-select) {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%235c6678'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 14px center;
  }
  html[data-theme="light"] input[type=number],
  html[data-theme="light"] input[type=month],
  html[data-theme="light"] input[type=date] { color-scheme: light; }
  .wrap { width: 100%; max-width: 1000px; position: relative; z-index: 1; }
  .watermark {
    position: fixed; left: -40px; top: 50%; transform: translateY(-50%);
    width: 760px; opacity: 1; pointer-events: none; z-index: 0; user-select: none;
  }
  .watermark img { width: 100%; height: auto; display: block; }
  header { margin-bottom: 28px; }
  header h1 { font-size: 26px; font-weight: 700; background: linear-gradient(90deg, var(--accent), var(--accent-2)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
  header p { color: var(--muted); margin-top: 6px; font-size: 14px; }
  header.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .top-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  .admin-link {
    display: inline-flex; align-items: center; gap: 8px; padding: 9px 16px; flex-shrink: 0;
    border: 1px solid var(--border); border-radius: 22px; background: var(--panel-2); color: var(--text);
    font-size: 13px; font-weight: 600; text-decoration: none; white-space: nowrap;
    transition: border-color .15s, background .15s, color .2s;
  }
  .admin-link:hover { border-color: var(--accent); color: var(--accent); }
  .admin-link svg { width: 15px; height: 15px; flex-shrink: 0; }
  .theme-toggle {
    display: inline-flex; align-items: center; gap: 10px; padding: 8px 14px 8px 10px; flex-shrink: 0;
    border: 1px solid var(--border); border-radius: 22px; background: var(--panel-2); color: var(--text);
    font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap;
    transition: border-color .15s, background .15s, color .2s;
  }
  .theme-toggle:hover { border-color: var(--accent); }
  .tt-track { position: relative; width: 40px; height: 22px; border-radius: 20px; flex-shrink: 0;
    background: linear-gradient(90deg, var(--accent), var(--accent-2)); transition: background .2s; }
  .tt-knob { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.4); transition: transform .2s ease; }
  html[data-theme="light"] .tt-knob { transform: translateX(18px); }

  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 24px;
    margin-bottom: 20px;
  }
  .card h2 { font-size: 17px; font-weight: 600; margin-bottom: 4px; display:flex; align-items:center; gap:10px; }
  .card .sub { color: var(--muted); font-size: 13px; margin-bottom: 18px; }
  .badge {
    font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 20px;
    background: rgba(79,140,255,.15); color: var(--accent); letter-spacing:.3px;
  }
  .env-badge {
    display: inline-block; vertical-align: middle; font-size: 11px; font-weight: 800; letter-spacing: .5px;
    padding: 3px 9px; border-radius: 20px; background: rgba(255,196,0,.18); color: #b8860b;
    -webkit-text-fill-color: #b8860b; border: 1px solid rgba(196,138,0,.5);
  }
  html[data-theme="dark"] .env-badge { background: rgba(255,196,0,.15); color: #ffd166; -webkit-text-fill-color: #ffd166; border-color: rgba(255,196,0,.45); }

  .tabs { display: flex; gap: 6px; background: var(--panel-2); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px; margin-bottom: 20px; }
  .tab {
    flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 12px 14px;
    border: none; border-radius: 9px; background: transparent; color: var(--muted); font-size: 14px; font-weight: 600; cursor: pointer;
    transition: color .15s, background .15s, box-shadow .15s;
  }
  .tab:hover { color: var(--text); }
  .tab.active { background: var(--panel); color: var(--text); box-shadow: inset 0 0 0 1px var(--border), 0 1px 5px rgba(0,0,0,.22); }
  .tab .t-num {
    display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 5px; flex-shrink: 0;
    border-radius: 10px; background: rgba(79,140,255,.15); color: var(--accent); font-size: 11px; font-weight: 700;
  }
  .tab.active .t-num { color: var(--text); }
  .tab .badge { margin-left: 2px; }
  /* Вкладка результатов появляется только после завершения задания. */
  .tab.tab-hidden { display: none; }
  .tab-panel { display: none; }
  .tab-panel.show { display: block; animation: tabIn .18s ease; }
  @keyframes tabIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

  /* Группировка пунктов аудита: верхнеуровневые табы блоков. */
  .audit-blockbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; margin-bottom: 16px; flex-wrap: wrap; }
  .btabs { display: flex; gap: 4px; flex-wrap: wrap; }
  .btab {
    padding: 10px 20px; border: 1px solid var(--border); border-radius: 9px;
    background: var(--panel-2); color: var(--muted); font-size: 14px; font-weight: 700; cursor: pointer;
    transition: color .15s, background .15s, box-shadow .15s;
  }
  .btab:hover { color: var(--text); }
  .btab.active {
    background: linear-gradient(135deg, rgba(79,140,255,.18), rgba(160,100,255,.10));
    color: var(--text); box-shadow: inset 0 0 0 1px var(--accent), 0 1px 5px rgba(0,0,0,.22);
  }
  .bpanel { display: none; }
  .bpanel.show { display: block; animation: tabIn .18s ease; }
  .tab.side { flex: 0 0 auto; }
  #audit-results-card { scroll-margin-top: 20px; }
  .range-row { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
  .range-row input[type=range] { width: 100%; max-width: 380px; accent-color: var(--accent); cursor: pointer; }
  .range-val { font-size: 14px; font-weight: 700; color: var(--text); min-width: 140px; }
  .audit-disclaimer { background: rgba(255,196,0,.12); border: 1px solid rgba(255,196,0,.45); color: #ffd166; border-radius: 9px; padding: 12px 14px; font-size: 13px; line-height: 1.55; margin-bottom: 14px; }
  .audit-disclaimer b { color: #ffe08a; }
  html[data-theme="light"] .audit-disclaimer {
    background: rgba(255,196,0,.16); border-color: rgba(196,138,0,.55); color: #6b5200;
  }
  html[data-theme="light"] .audit-disclaimer b { color: #4d3c00; }
  .audit-queue { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; }
  .queue-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 9px; padding: 10px 14px; font-size: 13px; }
  .queue-item.run { border-color: rgba(79,140,255,.5); }
  .queue-item .q-main { min-width: 0; }
  .queue-item .q-name { font-weight: 600; color: var(--text); word-break: break-word; }
  .queue-item .q-meta { color: var(--muted); margin-top: 2px; }
  .queue-item .q-remove { flex: 0 0 auto; padding: 7px 12px; border-radius: 7px; border: 1px solid var(--border); background: transparent; color: var(--danger); font-size: 13px; font-weight: 600; cursor: pointer; }
  .queue-item .q-remove:hover { border-color: var(--danger); background: rgba(255,92,108,.08); }
  .audit-toolbar { display: flex; align-items: center; gap: 14px; margin: 2px 0 16px; flex-wrap: wrap; }
  .audit-counter { font-size: 13px; color: var(--muted); }
  .audit-checks { display: flex; flex-direction: column; gap: 18px; margin-bottom: 22px; }
  .audit-group-title { font-size: 13px; font-weight: 700; color: var(--text); margin-bottom: 8px; padding-left: 10px; border-left: 3px solid var(--accent); }
  .check.disabled { opacity: .55; cursor: not-allowed; }
  .check.disabled:hover { border-color: var(--border); }

  .brand { margin-bottom: 12px; }
  .brand h1 { font-size: 22px; margin-bottom: 2px; }
  .brand p { color: var(--muted); font-size: 13px; margin-top: 0; }

  .gtabs { display: flex; gap: 4px; margin-bottom: 16px; }
  .gtab {
    padding: 10px 22px; border: 1px solid var(--border); border-radius: 9px;
    background: var(--panel-2); color: var(--muted); font-size: 14px; font-weight: 700; cursor: pointer;
    transition: color .15s, background .15s, box-shadow .15s;
  }
  .gtab:hover { color: var(--text); }
  .gtab.active {
    background: linear-gradient(135deg, rgba(79,140,255,.18), rgba(160,100,255,.10));
    color: var(--text); box-shadow: inset 0 0 0 1px var(--accent), 0 1px 5px rgba(0,0,0,.22);
  }

  .group { display: none; }
  .group.show { display: block; animation: tabIn .18s ease; }

  label.field { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; font-weight:500; }
  input[type=text] {
    width: 100%; padding: 12px 14px; background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 8px; color: var(--text); font-size: 14px; outline: none; margin-bottom: 16px; transition: border-color .15s;
  }
  input[type=text]:focus { border-color: var(--accent); }
  input[type=number] {
    padding: 12px 14px; background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 8px; color: var(--text); font-size: 14px; outline: none; margin-bottom: 16px; transition: border-color .15s;
    color-scheme: dark; font-family: inherit;
  }
  input[type=number]:focus { border-color: var(--accent); }

  textarea {
    width: 100%; padding: 12px 14px; background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 8px; color: var(--text); font-size: 14px; outline: none; margin-bottom: 16px; transition: border-color .15s;
    font-family: inherit; resize: vertical; line-height: 1.5;
  }
  textarea:focus { border-color: var(--accent); }

  select {
    width: 100%; padding: 12px 14px; background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 8px; color: var(--text); font-size: 14px; outline: none; margin-bottom: 16px; cursor: pointer;
    appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%239aa3b2'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 14px center; padding-right: 34px;
  }
  select:focus { border-color: var(--accent); }

  .region-scroll { max-height: 132px; overflow-y: auto; margin-bottom: 16px; padding: 8px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; }
  .region-scroll::-webkit-scrollbar { width: 5px; }
  .region-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  input[type=month] {
    width: 100%; padding: 12px 14px; background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 8px; color: var(--text); font-size: 14px; outline: none; margin-bottom: 16px; transition: border-color .15s;
    color-scheme: dark; font-family: inherit;
  }
  input[type=month]:focus { border-color: var(--accent); }
  input[type=date] {
    width: 100%; padding: 12px 14px; background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 8px; color: var(--text); font-size: 14px; outline: none; margin-bottom: 16px; transition: border-color .15s;
    color-scheme: dark; font-family: inherit;
  }
  input[type=date]:focus { border-color: var(--accent); }
  .period-row { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 8px; }
  .period-col { flex: 1; min-width: 180px; }
  .period-hint { font-size: 12px; color: var(--muted); margin: 6px 0 16px; line-height: 1.5; }

  .check-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; margin-bottom: 16px; }
  .check {
    display: flex; align-items: center; gap: 9px; padding: 10px 12px; background: var(--panel-2);
    border: 1px solid var(--border); border-radius: 8px; cursor: pointer; user-select: none; transition: all .12s; font-size: 14px;
  }
  .check:hover { border-color: var(--accent); }
  .check input { width: 17px; height: 17px; accent-color: var(--accent); cursor: pointer; flex-shrink:0; }
  .check.checked { border-color: var(--accent); background: rgba(79,140,255,.08); }

  .inline-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .inline-row .project-select { margin-bottom: 0; }
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    padding: 13px 20px; border: none; border-radius: 9px; font-size: 15px; font-weight: 600; cursor: pointer;
    color: #fff; background: linear-gradient(90deg, var(--accent), var(--accent-2));
    transition: filter .15s, transform .05s; flex: 1; min-width: 200px;
  }
  .btn:hover { filter: brightness(1.08); }
  .btn:active { transform: translateY(1px); }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .btn.ghost { background: var(--panel-2); border: 1px solid var(--border); color: var(--text); }
  .btn.browse { background: var(--panel-2); border: 1px solid var(--border); color: var(--text); flex: 0 0 auto; min-width: 0; }

  .status { margin-top: 14px; padding: 12px 14px; border-radius: 9px; font-size: 14px; display: none; line-height:1.5; }
  .status.show { display: block; }
  .status.ok { background: rgba(53,196,139,.12); border: 1px solid rgba(53,196,139,.4); color: var(--green); }
  .status.err { background: rgba(255,92,108,.12); border: 1px solid rgba(255,92,108,.4); color: var(--danger); }
  .status.wait { background: rgba(79,140,255,.12); border: 1px solid rgba(79,140,255,.4); color: var(--accent); }
  .status b { display:block; }

  .progress { height: 8px; border-radius: 20px; background: var(--panel-2); overflow: hidden; margin: 8px 0 4px; }
  .progress > i { display: block; height: 100%; border-radius: 20px; background: linear-gradient(90deg, var(--accent), var(--accent-2)); transition: width .3s ease; }
  .progress.running > i { width: 0%; }
  .progress.done > i { width: 100%; background: var(--green); }
  .progress.error > i { width: 100%; background: var(--danger); }
  .progress.cancelled > i { width: 100%; background: var(--muted); }
  .task-pct { font-size: 12px; font-weight: 700; color: var(--accent); margin-bottom: 2px; }
  .task-msg { font-size: 13px; color: var(--muted); line-height: 1.5; word-break: break-word; }
  .task-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .task-actions .btn { flex: 0 0 auto; min-width: 0; }
  .btn.danger { background: rgba(255,92,108,.14); border: 1px solid rgba(255,92,108,.5); color: var(--danger); }

  .cat-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
  .chip { padding: 7px 14px; border-radius: 20px; border: 1px solid var(--border); background: var(--panel-2); color: var(--muted); font-size: 13px; font-weight: 600; cursor: pointer; transition: all .12s; }
  .chip:hover { color: var(--text); }
  .chip.active { border-color: var(--accent); color: var(--text); background: rgba(79,140,255,.12); }

  .filter-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 14px; }
  .filter-col { display: flex; flex-direction: column; gap: 6px; }
  .filter-col label { font-size: 12px; color: var(--muted); font-weight: 600; }
  .filter-col select { margin-bottom: 0; width: auto; min-width: 150px; padding: 9px 30px 9px 12px; font-size: 13px; }
  .filter-col input[type=month] { margin-bottom: 0; width: auto; min-width: 170px; padding: 9px 12px; font-size: 13px; }
  .filter-col input[type=date] { margin-bottom: 0; width: auto; min-width: 170px; padding: 9px 12px; font-size: 13px; }
  .filter-col input[type=text] { margin-bottom: 0; width: auto; min-width: 180px; padding: 9px 12px; font-size: 13px; }
  .r-cat { display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; padding: 2px 8px; border-radius: 20px; background: rgba(79,140,255,.12); color: var(--accent); vertical-align: 2px; margin-left: 6px; }

  .file-hint { font-size: 12px; color: var(--muted); margin-top: 8px; line-height: 1.5; }
  .divider { height:1px; background: var(--border); margin: 4px 0 16px; }
  .summary { background: var(--panel-2); border:1px solid var(--border); border-radius:10px; padding:16px 18px; margin-top:18px; font-size:13px; color:var(--muted); line-height:1.7; }
  .summary > b { display:block; color:var(--text); font-size:14px; margin-bottom:8px; }
  .summary code { background: var(--code-bg); padding:1px 6px; border-radius:5px; font-size:12px; color:var(--text); }
  .summary ol, .summary ul { margin:0 0 0 18px; }
  .summary li { margin-bottom:5px; }
  .summary li:last-child { margin-bottom:0; }
  footer { color: var(--muted); font-size: 12px; text-align: center; margin-top: 26px; }

  .dropzone {
    border: 2px dashed var(--border); border-radius: 12px; padding: 24px 18px; text-align: center;
    cursor: pointer; transition: border-color .15s, background .15s; position: relative; margin-bottom: 16px;
  }
  .dropzone:hover, .dropzone.over { border-color: var(--accent); background: rgba(79,140,255,.05); }
  .dropzone input[type=file] { position: absolute; inset: 0; opacity: 0; cursor: pointer; width:100%; height:100%; }
  .dz-icon { font-size: 26px; margin-bottom: 6px; }
  .dz-text { font-size: 14px; font-weight: 600; color: var(--text); }
  .dz-sub { font-size: 12px; color: var(--muted); margin-top: 5px; line-height: 1.5; }
  .dz-chosen { display: none; margin-top: 10px; font-size: 13px; color: var(--green); background: rgba(53,196,139,.1); border:1px solid rgba(53,196,139,.35); border-radius:8px; padding:8px 12px; }
  .dz-chosen.show { display: block; }
  .dz-chosen .dz-clear { color: var(--danger); cursor: pointer; margin-left: 8px; font-weight:600; }
  .dz-err { color: var(--danger); font-size: 12px; margin-top: 6px; display:none; }
  .dz-err.show { display:block; }
  .or-sep { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .or-sep::before, .or-sep::after { content: ""; height: 1px; background: var(--border); flex: 1; }

  .r-item { display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 9px; margin-bottom: 8px; }
  .project-select {
    flex: 1; min-width: 220px; height: 44px; padding: 0 14px; background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 8px; color: var(--text); font-size: 14px; outline: none; cursor: pointer;
  }
  .project-select:focus { border-color: var(--accent); }
  .proj-date { font-size: 13px; font-weight: 700; color: var(--accent); margin: 16px 0 8px; display: flex; align-items: center; gap: 8px; }
  .proj-date::after { content: ""; height: 1px; background: var(--border); flex: 1; }
  .r-icon { font-size: 22px; flex-shrink: 0; }
  .r-info { flex: 1; min-width: 0; }
  .r-name { font-size: 14px; font-weight: 600; color: var(--text); word-break: break-word; }
  .r-meta { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .r-actions { display: flex; gap: 8px; flex-shrink: 0; }
  .r-btn { padding: 8px 12px; border-radius: 7px; font-size: 13px; font-weight: 600; cursor: pointer; border: 1px solid var(--border); background: var(--panel-2); color: var(--text); text-decoration: none; transition: border-color .12s, background .12s; }
  .r-btn:hover { border-color: var(--accent); }
  .r-btn.primary { background: linear-gradient(90deg, var(--accent), var(--accent-2)); border: none; color: #fff; }
  .r-btn.danger { color: var(--danger); }
  .r-btn.danger:hover { border-color: var(--danger); background: rgba(255,92,108,.08); }
  .r-empty { color: var(--muted); font-size: 14px; padding: 16px 4px; }

  .modal-overlay { position: fixed; inset: 0; background: rgba(5,7,12,.7); display: none; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
  .modal-overlay.show { display: flex; }
  .modal { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; width: 100%; max-width: 980px; max-height: 88vh; display: flex; flex-direction: column; overflow: hidden; }
  .modal-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--border); font-size: 15px; }
  .modal-close { cursor: pointer; color: var(--muted); font-size: 18px; padding: 4px 8px; }
  .modal-close:hover { color: var(--text); }
  .modal-body { overflow: auto; padding: 14px 18px; }
  .modal-foot { padding: 12px 18px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; }
  table.preview { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.preview th, table.preview td { border: 1px solid var(--border); padding: 6px 9px; text-align: left; white-space: nowrap; max-width: 340px; overflow: hidden; text-overflow: ellipsis; }
  table.preview th { background: var(--panel-2); position: sticky; top: 0; }
  table.preview td { background: var(--panel); }
</style>
<script>
(function(){try{var t=localStorage.getItem('seo-theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();
</script>
</head>
<body>
<div class="watermark"><img src="/img/bg.png" alt=""></div>
<div class="wrap">
  <header class="top">
    <div class="brand">
      <h1>SEO-центр${isTest ? ' <span class="env-badge">ТЕСТ</span>' : ''}</h1>
      <p>Визуальный запуск навыков opencode</p>
    </div>
    <div class="top-actions">
      ${auth && (auth.role === "admin" || auth.role === "it") ? `<a class="admin-link" href="/insights" title="История, проблемы, расписание"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 4-6"/></svg>Аналитика</a><a class="admin-link" href="/generators" title="robots.txt, sitemap.xml, JSON-LD"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>Генераторы</a>` : ""}
      ${auth && (auth.role === "admin" || auth.role === "it") ? `<a class="admin-link" href="/admin" title="Админ-панель"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>Админ-панель</a>` : ""}
      <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Переключить тему" title="Переключить тему">
        <span class="tt-track"><span class="tt-knob"></span></span>
        <span class="tt-label">Тёмная тема</span>
      </button>
    </div>
  </header>

  <div class="gtabs" role="tablist">
    <button class="gtab active" data-group="tools">SEO-инструменты</button>
    <button class="gtab" data-group="audit">SEO-аудит</button>
    <button class="gtab" data-group="smm">SMM-инструменты</button>
  </div>

  <div class="group show" id="group-tools" data-group="tools">

  <div class="tabs" role="tablist">
    <button class="tab active" data-tab="extract"><span class="t-num">1</span> Выгрузка метатегов</button>
    <button class="tab" data-tab="metatags"><span class="t-num">2</span> Метатеги по семядру</button>
    <button class="tab" data-tab="wordstat"><span class="t-num">3</span> Wordstat</button>
    <button class="tab" data-tab="topics"><span class="t-num">4</span> Темы статей</button>
    <button class="tab" data-tab="articles"><span class="t-num">5</span> Статьи</button>
    <button class="tab" data-tab="microdata"><span class="t-num">6</span> Микроразметка</button>
    <button class="tab" data-tab="results" data-results-tab="1"><span class="t-num">7</span> Результаты</button>
  </div>

  <!-- ============ ВЫГРУЗКА ============ -->
  <section class="tab-panel show" id="panel-extract">
  <div class="card">
    <h2><span>1</span> Выгрузка метатегов с сайта</h2>
    <p class="sub">Обход сайта по sitemap / краулинг и извлечение метаданных в таблицу <code>Метатеги_&lt;хост&gt;.csv</code>.</p>

    <label class="field" for="extract-url">URL сайта *</label>
    <input type="text" id="extract-url" placeholder="https://example.com/">

    <label class="field">Что выгружать</label>
    <div class="check-grid" id="extract-checks">
      <label class="check"><input type="checkbox" value="title" checked><span>title</span></label>
      <label class="check"><input type="checkbox" value="description" checked><span>description</span></label>
      <label class="check"><input type="checkbox" value="H1" checked><span>H1</span></label>
      <label class="check"><input type="checkbox" value="H2" checked><span>H2</span></label>
      <label class="check"><input type="checkbox" value="H3"><span>H3</span></label>
      <label class="check"><input type="checkbox" value="H4"><span>H4</span></label>
      <label class="check"><input type="checkbox" value="H5"><span>H5</span></label>
      <label class="check"><input type="checkbox" value="H6"><span>H6</span></label>
    </div>

    <button class="btn" id="run-extract">Запустить выгрузку</button>
    <div class="status" id="status-extract"></div>
  </div>
  <div class="summary">
    <b>Как это работает</b>
    <ol>
      <li>Введи адрес сайта, например <code>https://example.com/</code>.</li>
      <li>Отметь, что нужно собрать: <code>title</code>, <code>description</code>, заголовки <code>H1–H6</code>.</li>
      <li>Нажми «Запустить выгрузку» — задание уходит в opencode, и навык <code>seo-metatags-extract</code> начинает работу.</li>
      <li>Навык обходит сайт: сначала по <code>sitemap.xml</code>, а если он подозрительный — по ссылкам со страниц.</li>
      <li>В итоговую таблицу попадают только страницы с ответом 200 — остальные пропускаются.</li>
      <li>Готовый файл <code>Метатеги_&lt;хост&gt;.csv</code> появится на вкладке «Результаты».</li>
    </ol>
  </div>
  </section>

  <!-- ============ СОСТАВЛЕНИЕ МЕТА ============ -->
  <section class="tab-panel" id="panel-metatags">
  <div class="card">
    <h2><span>2</span> Составление метатегов по семядру</h2>
    <p class="sub">По файлу семантического ядра (.xlsx/.csv) составить оптимизированные <b>title</b> и <b>description</b> и сохранить таблицу.</p>

    <label class="field" for="meta-url">URL сайта (проверяемый проект) *</label>
    <input type="text" id="meta-url" placeholder="https://example.com/">
    <div class="file-hint" style="margin-top:-10px">Нужен для имени папки результатов: <code>seo-results/example.com/2026-09-02_14-30-00/</code></div>

    <label class="field">Файл семантического ядра *</label>
    <div class="dropzone" id="dropzone-core">
      <input type="file" id="core-file" accept=".xlsx,.xls,.csv">
      <div class="dz-icon">📄</div>
      <div class="dz-text" id="dz-text">Перетащи файл сюда или выбери его</div>
      <div class="dz-sub">.xlsx / .xls / .csv — файл будет отправлен на сервер (машина с opencode). Без файла навык не запустится.</div>
      <div class="dz-chosen" id="dz-chosen"></div>
      <div class="dz-err" id="dz-err">Слишком большой файл (макс. 50 МБ) или неверный формат.</div>
    </div>

    <div class="divider" style="margin-top:18px;"></div>
    <div class="file-hint" style="margin:0 0 4px;">Метатеги всегда составляются заново: title с разделителем <code>|</code> и названием компании, description с точкой на конце.</div>

    <button class="btn" id="run-metatags">Составить метатеги</button>
    <div class="status" id="status-metatags"></div>
  </div>
  <div class="summary">
    <b>Как это работает</b>
    <ol>
      <li>Введи URL сайта — он нужен для названия папки с результатами.</li>
      <li>Загрузи файл семантического ядра (<code>.xlsx</code>/<code>.csv</code>) — перетащи его или выбери.</li>
      <li>Нажми «Составить метатеги» — задание уходит в opencode, навык <code>seo-metatags</code> начинает работу.</li>
      <li>Навык определяет по ядру целевые страницы и анализирует кластеры запросов к каждой.</li>
      <li>Составляет новые <code>title</code> (с разделителем <code>|</code> и названием компании) и <code>description</code> (с точкой в конце).</li>
      <li>Результат — файлы <code>Метатеги_новые_&lt;хост&gt;.xlsx</code> и <code>.csv</code> на вкладке «Результаты».</li>
    </ol>
  </div>
  </section>

  <!-- ============ WORDSTAT ============ -->
  <section class="tab-panel" id="panel-wordstat">
    <div class="card">
      <h2><span>3</span> Wordstat</h2>
      <p class="sub">Сбор данных Wordstat (динамика числа запросов по месяцам) через навык <code>wordstat</code>.</p>

      <label class="field" for="ws-queries">Список запросов *</label>
      <textarea id="ws-queries" rows="5" placeholder="Вставь запросы, по одному на строку:&#10;кладка кирпичная&#10;кирпич облицовочный&#10;…"></textarea>
      <div class="file-hint" style="margin-top:-8px">Каждый запрос с новой строки. Можно 1 или 100.</div>

      <label class="field" for="ws-region-filter">Регион анализа (из Яндекс.Вордстата)</label>
      <input type="text" id="ws-region-filter" placeholder="Поиск региона… (например: Москва, Татарстан)">
      <div class="file-hint" style="margin-top:-10px">Начни вводить название — список ниже отфильтруется по первым буквам.</div>
      <div class="region-scroll" id="ws-regions"></div>
      <div class="file-hint" style="margin-top:-8px">Список регионов подгружается с wordstat.yandex.ru. Можно прокрутить и кликнуть, или найти через поле поиска.</div>

      <div class="field">Период для выгрузки *</div>
      <div class="period-row">
        <div class="period-col">
          <label class="field" for="ws-period-from">С (месяц)</label>
          <input type="month" id="ws-period-from">
        </div>
        <div class="period-col">
          <label class="field" for="ws-period-to">По (месяц)</label>
          <input type="month" id="ws-period-to">
        </div>
      </div>
      <div class="period-hint">Выбери диапазон месяцев, например <b>2026-09</b> — <b>2026-11</b>. Если оставить пустым — возьмётся последний год.</div>
      <label class="field" for="ws-account" style="margin-top:6px;">Логин в Яндекс (здесь выполняется вход)</label>
      <input type="text" id="ws-account" placeholder="телефон или e-mail">

      <label class="field">Устройства</label>
      <div class="check-grid" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr));" id="ws-devices">
        <label class="check"><input type="radio" name="ws-device" value="Десктопы" checked><span>Десктопы</span></label>
        <label class="check"><input type="radio" name="ws-device" value="Смартфоны"><span>Смартфоны</span></label>
        <label class="check"><input type="radio" name="ws-device" value="Планшеты"><span>Планшеты</span></label>
        <label class="check"><input type="radio" name="ws-device" value="Все устройства"><span>Все</span></label>
      </div>

      <label class="field" style="margin-top:6px;">Разбивка на графике (вкладка «Динамика»)</label>
      <div class="check-grid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr));" id="ws-break">
        <label class="check"><input type="radio" name="ws-break" value="month" checked><span>По месяцам</span></label>
        <label class="check"><input type="radio" name="ws-break" value="week"><span>По неделям</span></label>
        <label class="check"><input type="radio" name="ws-break" value="day"><span>По дням</span></label>
      </div>

      <button class="btn" id="run-wordstat">Запустить сбор Wordstat</button>
      <div class="status" id="status-wordstat"></div>
    </div>
    <div class="summary">
      <b>Как это работает</b>
      <ol>
        <li>Вставь список запросов — по одному на строку.</li>
        <li>Выбери регион (или оставь «Все регионы»), период, устройства и разбивку на графике.</li>
        <li>Укажи логин Яндекса — при запуске в браузере откроется окно входа в Wordstat.</li>
        <li>Нажми «Запустить сбор Wordstat» — навык <code>wordstat</code> открывает wordstat.yandex.ru и по каждому запросу собирает динамику по месяцам.</li>
        <li>Результат — CSV-файлы по каждому запросу на вкладке «Результаты».</li>
      </ol>
    </div>
  </section>

  <!-- ============ ГЕНЕРАЦИЯ ТЕМ ============ -->
  <section class="tab-panel" id="panel-topics">
    <div class="card">
      <h2><span>4</span> Генерация тем статей</h2>
      <p class="sub">Генерация уникальных тем для статей по сайту с семантическим ядром и частотностью Wordstat (навык <code>seo-topics</code>).</p>

      <label class="field" for="tp-url">URL сайта *</label>
      <input type="text" id="tp-url" placeholder="https://example.com/">
      <div class="file-hint" style="margin-top:-10px">Навык сам найдёт блок статей/блога на сайте и определит существующие материалы, чтобы темы были уникальными.</div>

      <label class="field" for="tp-competitors">URL конкурентов <small style="color:var(--muted)">(необязательно)</small></label>
      <textarea id="tp-competitors" rows="3" placeholder="По одному URL на строку:&#10;https://konkurent1.ru/blog/&#10;https://konkurent2.ru/&#10;Оставь пустым — навык сам найдёт конкурентов в поиске."></textarea>
      <div class="file-hint" style="margin-top:-8px">Если укажешь — навык смотрит эти сайты. Если пусто — сам ищет конкурентов в поиске.</div>

      <div class="divider" style="margin-top:14px;"></div>
      <div class="file-hint" style="margin:0 0 4px;">Частотность запросов не настраивается — по каждой теме собирается <b>6–11 запросов</b>, равномерно: высокочастотные (ВЧ), среднечастотные (СЧ) и низкочастотные (НЧ), без перекоса в одну группу. Запросы с частотностью выше 30 000 не берутся.</div>

      <label class="field" for="tp-account" style="margin-top:8px;">Логин в Яндекс (телефон) <small style="color:var(--muted)">— для автоподстановки в окно авторизации Wordstat</small></label>
      <input type="text" id="tp-account" placeholder="телефон или e-mail">
      <div class="file-hint" style="margin-top:-10px">Подставится в окно входа в Яндекс, если при сборе частотности понадобится авторизация (первый запуск или протухшая сессия).</div>

      <label class="field" for="tp-count">Количество тем (1–50)</label>
      <input type="number" id="tp-count" min="1" max="50" placeholder="10" style="width: 160px;">
      <div class="file-hint" style="margin-top:-10px">Число от 1 до 50. По умолчанию 10.</div>

      <button class="btn" id="run-topics">Сгенерировать темы</button>
      <div class="status" id="status-topics"></div>
    </div>
    <div class="summary">
      <b>Как это работает</b>
      <ol>
        <li>Введи URL сайта, для которого нужны темы.</li>
        <li>Опционально укажи URL конкурентов — навык изучит их тематику. Если пусто — найдёт сам.</li>
        <li>Частотность не настраивается: по каждой теме собирается 6–11 запросов — ВЧ, СЧ и НЧ равномерно (не шире 30 000 показов).</li>
        <li>Укажи логин Яндекса (необязательно) и количество тем.</li>
        <li>Нажми «Сгенерировать темы» — навык <code>seo-topics</code> анализирует блог сайта, собирает семантическое ядро с частотностью Wordstat и генерирует уникальные темы.</li>
        <li>Результат — документ <code>Темы_для_блога_&lt;хост&gt;.xlsx</code> (плюс CSV-копия) на вкладке «Результаты» (его можно выбрать на вкладке «Статьи»).</li>
      </ol>
    </div>
  </section>

  <!-- ============ СТАТЬИ ============ -->
  <section class="tab-panel" id="panel-articles">
    <div class="card">
      <h2><span>5</span> Статьи</h2>
      <p class="sub">Написание материалов (навык <code>seo-articles</code>): информационные статьи по темам или коммерческий текст для страницы (новый / рерайт) с бренд-контекстом и meta.</p>

      <label class="field" for="ar-url" id="ar-url-label">URL сайта (для кого пишем) *</label>
      <input type="text" id="ar-url" placeholder="https://example.com/">
      <div class="file-hint" style="margin-top:-10px" id="ar-url-hint">Навык проверит сайт и сформирует бренд-контекст для компании и статей.</div>

      <label class="field" for="ar-type">Что пишем</label>
      <select id="ar-type">
        <option value="informational">Информационная статья — по темам</option>
        <option value="commercial">Коммерческий материал — для конкретной страницы</option>
      </select>
      <div class="file-hint" style="margin-top:-8px">Информационные материалы пишутся по темам (по умолчанию 5000–7000 знаков с пробелами). Коммерческие — для указанной страницы (по умолчанию 3000–4000 знаков с пробелами) с разбором её tone of voice. Если в ТЗ задан объём — он приоритетен. Ключевые фразы в DOCX подсвечиваются жёлтым.</div>

      <div id="ar-commercial-block" style="display:none;">
        <label class="field">Что за материал</label>
        <div class="check-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));">
          <label class="check"><input type="radio" name="ar-comm-mode" value="new" checked><span>Новый материал</span></label>
          <label class="check"><input type="radio" name="ar-comm-mode" value="rewrite"><span>Рерайт страницы</span></label>
        </div>
        <div class="file-hint" style="margin-top:-8px">Новый — уникальный текст (объём по ТЗ, иначе 3000–4000 знаков с пробелами) с обязательным призывом и ссылкой в конце. Рерайт — уникализация текущего текста страницы, добавление ключей, приведение к объёму из ТЗ (иначе 3000–4000 знаков с пробелами). Ключи подсвечиваются жёлтым.</div>
        <div class="divider" style="margin-top:14px;"></div>
      </div>

      <div id="ar-topic-source">
      <div class="field">Источник тем</div>
      <label class="check" id="ar-src-file-check" style="margin-bottom:8px;"><input type="radio" name="ar-source" value="file"><span>Загрузить ТЗ на написание</span></label>
      <div class="dropzone" id="dropzone-tz">
        <input type="file" id="tz-file" accept=".xlsx,.xls,.csv,.json,.txt,.md,.odt,.docx,.doc">
        <div class="dz-icon">📄</div>
        <div class="dz-text" id="tz-text">Перетащи файл ТЗ сюда или выбери его</div>
        <div class="dz-sub" id="tz-sub">.odt / .docx / .doc / .xlsx / .csv / .json / .txt / .md — навык определит темы, структуру и ключевые слова. Объём и требования из ТЗ приоритетны.</div>
        <div class="dz-chosen" id="tz-chosen"></div>
        <div class="dz-err" id="tz-err">Слишком большой файл (макс. 50 МБ) или неверный формат.</div>
      </div>

      <label class="check" id="ar-src-topics-check" style="margin:14px 0 8px;"><input type="radio" name="ar-source" value="topics"><span><b>Писать по сгенерированным темам</b> (из документа «Генерация тем статей»)</span></label>
      <label class="field" id="ar-topics-label" for="ar-topics-path">Документ с темами (Темы_для_блога_&lt;host&gt;.xlsx)</label>
      <div class="filter-row" id="ar-topics-filters" style="margin-bottom:10px;">
        <div class="filter-col">
          <label for="ar-tp-site">Сайт</label>
          <select id="ar-tp-site"><option value="">Все сайты</option></select>
        </div>
        <div class="filter-col">
          <label for="ar-tp-year">Год</label>
          <select id="ar-tp-year"><option value="">Все годы</option></select>
        </div>
        <div class="filter-col">
          <label for="ar-tp-month">Месяц</label>
          <select id="ar-tp-month">
            <option value="">Все месяцы</option>
            <option value="01">Январь</option>
            <option value="02">Февраль</option>
            <option value="03">Март</option>
            <option value="04">Апрель</option>
            <option value="05">Май</option>
            <option value="06">Июнь</option>
            <option value="07">Июль</option>
            <option value="08">Август</option>
            <option value="09">Сентябрь</option>
            <option value="10">Октябрь</option>
            <option value="11">Ноябрь</option>
            <option value="12">Декабрь</option>
          </select>
        </div>
        <button class="btn ghost" id="ar-tp-reset" style="flex:0 0 auto;min-width:0;height:40px;padding:0 16px;">Сбросить</button>
      </div>
      <select id="ar-topics-path" class="project-select">
        <option value="">— сначала выбери —</option>
      </select>
      <div class="file-hint" style="margin-top:-8px" id="ar-topics-hint">Документы <b>.xlsx</b>, сформированные на вкладке «Темы статей». Отфильтруй по сайту/месяцу и выбери один — навык возьмёт из него темы, структуру и ключевые слова.</div>
      </div>

      <div class="divider" style="margin-top:10px;"></div>

      <label class="field" for="ar-notes">Примечание <small style="color:var(--muted)">(необязательно)</small></label>
      <textarea id="ar-notes" rows="3" placeholder="Например: напиши по 10 000 слов, тон — экспертный, без CTA в начале…"></textarea>
      <div class="file-hint" style="margin-top:-8px">По умолчанию навык работает по своей логике. Если введёшь требования — они приоритетны (например «10 000 слов» или пожелания по структуре).</div>

      <div id="ar-count-wrap">
      <label class="field" for="ar-count">Количество статей (1–50)</label>
      <input type="number" id="ar-count" min="1" max="50" placeholder="10" style="width: 160px;">
      <div class="file-hint" style="margin-top:-10px">Не больше числа тем в источнике: если тем 20, а задано 50 — напишется 20, новые не придумываются.</div>
      </div>

      <button class="btn" id="run-articles">Написать статьи</button>
      <div class="status" id="status-articles"></div>

      <div class="divider" style="margin-top:18px;"></div>
      <label class="field">Правки в написанные тексты <small style="color:var(--muted)">(необязательно)</small></label>
      <div class="file-hint" style="margin-top:-8px">Введи URL сайта выше и нажми «Показать тексты» — по каждому материалу появится поле для правок (например «сократи на 500 знаков», «сделай более продающим»). Тексты правятся по отдельности.</div>
      <button class="btn ghost" id="load-edits" style="min-width:0;flex:0 0 auto;">Показать тексты</button>
      <div id="edits-list" style="margin-top:14px;"></div>
    </div>
    <div class="summary">
      <b>Как это работает</b>
      <ol>
        <li>Выбери, что пишем: <b>информационную статью</b> (по темам) или <b>коммерческий материал</b> (для конкретной страницы).</li>
        <li><b>Информационный режим:</b> введи URL сайта, выбери источник тем (ТЗ-файл или документ из «Генерации тем»), укажи количество статей.</li>
        <li><b>Коммерческий режим:</b> введи URL коммерческой страницы, выбери «новый материал» или «рерайт», при необходимости приложи ТЗ. Навык разберёт tone of voice страницы и фактуру с других разделов сайта.</li>
         <li>Нажми «Написать статьи» — навык <code>seo-articles</code> пишет: информационные статьи 5000–7000 знаков с пробелами, коммерческие — 3000–4000 знаков с пробелами (с CTA и ссылкой в конце). Если в ТЗ указан объём — он приоритетен. Ключевые фразы подсвечиваются жёлтым.</li>
        <li>Результат — документы <code>.docx</code> с датой и временем в имени (плюс <code>.meta.json</code> и <code>articles.json</code>) в папке <code>seo-results/&lt;хост&gt;/&lt;дата_время&gt;/articles/</code>.</li>
      </ol>
    </div>
  </section>

  <!-- ============ МИКРОРАЗМЕТКА ============ -->
  <section class="tab-panel" id="panel-microdata">
    <div class="card">
      <h2><span>6</span> Микроразметка</h2>
      <p class="sub">Аудит Schema.org и OpenGraph (навык <code>mikrorazmetka</code>): какие типы разметки есть на сайте, ошибки в полях и синтаксисе, что можно дополнить, и рекомендации по добавлению применимых типов. Результат — <code>.xlsx</code> по структуре справочника.</p>

      <label class="field" for="md-url">URL сайта *</label>
      <input type="text" id="md-url" placeholder="https://example.com/">
      <div class="file-hint" style="margin-top:-10px">Навык обойдёт сайт по <code>sitemap.xml</code> (или по внутренним ссылкам), разберёт Schema.org (JSON-LD и Microdata) и OpenGraph со всех типов страниц.</div>

      <button class="btn" id="run-microdata">Запустить аудит разметки</button>
      <div class="status" id="status-microdata"></div>
    </div>
    <div class="summary">
      <b>Как это работает</b>
      <ol>
        <li>Введи URL сайта, который нужно проверить.</li>
        <li>Нажми «Запустить аудит разметки» — задание уходит в opencode, навык <code>mikrorazmetka</code> начинает обход.</li>
        <li>Навык собирает все типы Schema.org (JSON-LD и Microdata) и OpenGraph, проверяет обязательные поля, синтаксис и корректность типов под контент.</li>
        <li>Отдельно подбирает применимые, но отсутствующие типы разметки и готовые примеры для внедрения.</li>
        <li>Результат — файл <code>Микроразметка_&lt;хост&gt;.xlsx</code> (листы «Разметка», «OpenGraph», «Справка») на вкладке «Результаты».</li>
      </ol>
    </div>
  </section>

  <!-- ============ РЕЗУЛЬТАТЫ ============ -->
  <section class="tab-panel" id="panel-results">
    <div class="card">
      <h2><span>6</span> Результаты</h2>
      <p class="sub">Таблицы по проекту из папки <code>seo-results/&lt;сайт&gt;/&lt;дата_время&gt;/</code>. Обновляется автоматически.</p>
      <label class="field" for="project-select">Проект (сайт)</label>
      <div class="inline-row">
        <select id="project-select" class="project-select">
          <option value="">— выбери проект —</option>
        </select>
        <button class="btn ghost" id="refresh-results" style="flex:0 0 auto;min-width:0;height:44px;padding:0 18px;">Обновить</button>
      </div>
      <div class="filter-row" id="results-filters" style="display:none;">
        <div class="filter-col">
          <label for="flt-cat">Тип задания</label>
          <select id="flt-cat">
            <option value="">Все типы</option>
            <option value="extract">Выгрузка метатегов</option>
            <option value="metatags">Метатеги</option>
            <option value="wordstat">Wordstat</option>
            <option value="topics">Темы статей</option>
            <option value="articles">Статьи</option>
            <option value="microdata">Микроразметка</option>
          </select>
        </div>
        <div class="filter-col">
          <label for="flt-year">Год</label>
          <select id="flt-year"><option value="">Все годы</option></select>
        </div>
        <div class="filter-col">
          <label for="flt-month">Месяц</label>
          <select id="flt-month">
            <option value="">Все месяцы</option>
            <option value="01">Январь</option>
            <option value="02">Февраль</option>
            <option value="03">Март</option>
            <option value="04">Апрель</option>
            <option value="05">Май</option>
            <option value="06">Июнь</option>
            <option value="07">Июль</option>
            <option value="08">Август</option>
            <option value="09">Сентябрь</option>
            <option value="10">Октябрь</option>
            <option value="11">Ноябрь</option>
            <option value="12">Декабрь</option>
          </select>
        </div>
        <div class="filter-col">
          <label for="flt-from">С даты</label>
          <input type="month" id="flt-from">
        </div>
        <div class="filter-col">
          <label for="flt-to">По дату</label>
          <input type="month" id="flt-to">
        </div>
        <button class="btn ghost" id="flt-reset" style="flex:0 0 auto;min-width:0;height:40px;padding:0 16px;">Сбросить</button>
      </div>
      <div id="results-list"><p style="color:var(--muted);font-size:14px;">Загрузка…</p></div>
      <div style="margin-top:16px;display:flex;justify-content:flex-end;">
        <button class="btn danger" id="delete-all-results" style="min-width:0;height:44px;padding:0 18px;">Удалить все файлы проекта</button>
      </div>
    </div>
    <div class="summary">
      <b>Как это работает</b>
      <ol>
        <li>Выбери проект (сайт) в списке — появятся папки с датой и временем запусков.</li>
        <li>Если результаты ещё не видны — нажми «Обновить».</li>
        <li>В списке появятся таблицы (CSV/XLSX) и документы (DOCX) с датой запуска.</li>
        <li>Фильтруй документы по категории и по периоду (год, месяц или диапазон «с — по»), если файлов много. Кнопка «Сбросить» очищает фильтры периода.</li>
        <li>Кнопками можно посмотреть предпросмотр, скачать или удалить файл.</li>
        <li>Список обновляется автоматически после запуска заданий на других вкладках.</li>
      </ol>
    </div>
  </section>

  </div><!-- /group-tools -->

  <!-- ============ SEO-АУДИТ ============ -->
  <div class="group" id="group-audit" data-group="audit">
    <div class="card">
      <h2>SEO-аудит</h2>
      <p class="sub">Отметь пункты аудита, укажи URL сайта и запусти проверку. Можно выбрать отдельные пункты или все сразу — результат придёт единым документом: пункты идут в заданном порядке, неотмеченные пропускаются.</p>

      <label class="field" for="audit-url">URL сайта *</label>
      <input type="text" id="audit-url" placeholder="https://example.com/">

      <label class="field" for="audit-depth-content">Пункт 2.1 «Текстовый контент» — глубина, страниц</label>
      <div class="range-row">
        <input type="range" id="audit-depth-content" min="1" max="1000" step="1" value="50">
        <span class="range-val" id="audit-depth-content-val">50</span>
      </div>
      <div class="file-hint" style="margin-top:-10px">По умолчанию 50 наиболее важных страниц (главная, каталоги/разделы, карточки, несколько статей). Ползунок 1–1000; крайнее правое положение (1000+) — все страницы сайта (может занять много времени).</div>

      <label class="field" for="audit-depth-speed" style="margin-top:16px;">Пункт 4.1 «Скорость загрузки» — глубина, страниц</label>
      <div class="range-row">
        <input type="range" id="audit-depth-speed" min="1" max="1000" step="1" value="10">
        <span class="range-val" id="audit-depth-speed-val">10</span>
      </div>
      <div class="file-hint" style="margin-top:-10px">По умолчанию 10 страниц: главная, «О компании», каталоги/разделы, разводящие страницы, контакты, карточки и другие важные страницы. Ползунок 1–1000; 1000+ — все страницы.</div>

      <div class="audit-toolbar" style="margin-top:12px;padding:12px;background:var(--panel-2);border:1px solid var(--border);border-radius:8px;">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <input type="checkbox" id="audit-dry-run" style="width:auto;margin:0">
          <span>Только проверить (без записи в историю, без уведомлений)</span>
        </label>
      </div>

      <label class="field" for="audit-core">Семантическое ядро <small style="color:var(--muted)">(необязательно; используется в пункте 2.3 «Служебные теги»)</small></label>
      <div class="dropzone" id="dropzone-audit-core" style="margin-bottom:16px;">
        <input type="file" id="audit-core" accept=".xlsx,.xls,.csv">
        <div class="dz-icon">📄</div>
        <div class="dz-text" id="audit-core-text">Перетащи файл семантического ядра или выбери его</div>
        <div class="dz-sub">.xlsx / .xls / .csv — колонки «Запросы», «Частотность», «Целевая страница». Если файл приложен, метатеги (2.3) составят по семантике; иначе — по базовым правилам.</div>
        <div class="dz-chosen" id="audit-core-chosen"></div>
        <div class="dz-err" id="audit-core-err">Слишком большой файл (макс. 50 МБ) или неверный формат.</div>
      </div>

      <div class="audit-toolbar">
        <button class="btn ghost" id="audit-select-all" type="button" style="flex:0 0 auto;min-width:0;padding:11px 18px;">Выбрать все</button>
        <span class="audit-counter" id="audit-counter"></span>
      </div>

      <div class="audit-toolbar">
        <select id="audit-preset" style="flex:1;min-width:200px;padding:10px;background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:8px;">
          <option value="">Пресет пунктов…</option>
        </select>
        <button class="btn ghost" id="audit-preset-apply" type="button" style="flex:0 0 auto;min-width:0;padding:11px 18px;">Применить</button>
        <button class="btn ghost" id="audit-preset-save" type="button" style="flex:0 0 auto;min-width:0;padding:11px 18px;">Сохранить пресет</button>
      </div>

      <div class="audit-checks" id="audit-checks">
        <div class="audit-group">
          <div class="audit-group-title">Анализ дружественности сайта поисковым машинам</div>
          <div class="check-grid">
            <label class="check"><input type="checkbox" data-point="1.1" data-skill="adresa-stranits"><span>1.1. Адреса страниц</span></label>
            <label class="check"><input type="checkbox" data-point="1.2" data-skill="dublikaty-stranits"><span>1.2. Дубликаты страниц</span></label>
            <label class="check"><input type="checkbox" data-point="1.3" data-skill="zagolovki-otklikov-servera"><span>1.3. Заголовки откликов сервера</span></label>
            <label class="check"><input type="checkbox" data-point="1.4" data-skill="indeksatsiya-sayta"><span>1.4. Индексация сайта</span></label>
            <label class="check"><input type="checkbox" data-point="1.5" data-skill="topologiya-ssylok"><span>1.5. Внутренняя ссылочная топология</span></label>
          </div>
        </div>
        <div class="audit-group">
          <div class="audit-group-title">Анализ страничных факторов</div>
          <div class="check-grid">
            <label class="check"><input type="checkbox" data-point="2.1" data-skill="tekstovyj-kontent"><span>2.1. Текстовый контент сайта</span></label>
            <label class="check"><input type="checkbox" data-point="2.2" data-skill="oformlenie-teksta"><span>2.2. Оформление текста</span></label>
            <label class="check"><input type="checkbox" data-point="2.3" data-skill="sluzhebnye-tegi"><span>2.3. Служебные теги</span></label>
            <label class="check"><input type="checkbox" data-point="2.4" data-skill="izobrazheniya"><span>2.4. Изображения</span></label>
            <label class="check"><input type="checkbox" data-point="2.5" data-skill="ishodyashchie-ssylki"><span>2.5. Исходящие ссылки</span></label>
            <label class="check"><input type="checkbox" data-point="2.6" data-skill="mikrorazmetka"><span>2.6. Микроразметка</span></label>
          </div>
        </div>
        <div class="audit-group">
          <div class="audit-group-title">Внешние показатели</div>
          <div class="check-grid">
            <label class="check"><input type="checkbox" data-point="3.1" data-skill="snippety"><span>3.1. Сниппеты</span></label>
            <label class="check"><input type="checkbox" data-point="3.2" data-skill="vneshnie-ssylki"><span>3.2. Внешние ссылки</span></label>
          </div>
        </div>
        <div class="audit-group">
          <div class="audit-group-title">Анализ технических факторов со стороны сервера</div>
          <div class="check-grid">
            <label class="check"><input type="checkbox" data-point="4.1" data-skill="skorost-zagruzki"><span>4.1. Скорость загрузки страниц</span></label>
            <label class="check"><input type="checkbox" data-point="4.2" data-skill="pereboi-v-rabote"><span>4.2. Перебои в работе сайта</span></label>
          </div>
        </div>
        <div class="audit-group">
          <div class="audit-group-title">Готовность к ИИ-поиску (GEO/AEO)</div>
          <div class="check-grid">
            <label class="check"><input type="checkbox" data-point="5.1" data-skill="geo-aeo-audit"><span>5.1. GEO/AEO аудит (поиск в ИИ-поисковиках)</span></label>
          </div>
        </div>
      </div>

      <div class="audit-disclaimer">
        Одновременно выполняется <b>не более 2 аудитов</b>. Если свободных мест нет — ваше задание встанет <b>в очередь</b>: покажем позицию и примерное время ожидания. Передумали? Нажмите <b>«Убрать из очереди»</b> в блоке ниже.
      </div>

      <button class="btn" id="run-audit">Запустить аудит (или поставить в очередь)</button>
      <div class="status" id="status-audit"></div>
      <div class="audit-queue" id="audit-queue"></div>
    </div>

    <div class="summary">
      <b>Как это работает</b>
      <ol>
        <li>Отметь пункты аудита (или нажми «Выбрать все»).</li>
        <li>Введи URL сайта, который нужно проверить.</li>
        <li>Нажми «Запустить аудит» — задание уходит в opencode, навыки по отмеченным пунктам выполняются по порядку.</li>
        <li>Результат — единый документ со всеми выбранными пунктами в заданном порядке (неотмеченные пропускаются).</li>
        <li>Готовые документы появляются в блоке «Результаты аудита» ниже.</li>
      </ol>
    </div>

    <div class="card" id="audit-results-card">
      <h2>Результаты аудита</h2>
      <p class="sub">Итоговые документы аудита: единый отчёт <code>.docx</code> и таблицы (<code>.xlsx</code>, <code>.csv</code>).</p>
      <label class="field" for="audit-project">Проект (сайт)</label>
      <div class="inline-row">
        <select id="audit-project" class="project-select">
          <option value="">— выбери проект —</option>
        </select>
        <button class="btn ghost" id="refresh-audit-results" style="flex:0 0 auto;min-width:0;height:44px;padding:0 18px;">Обновить</button>
      </div>
      <div id="audit-results-list"><p style="color:var(--muted);font-size:14px;">Загрузка…</p></div>
      <div style="margin-top:16px;display:flex;justify-content:flex-end;">
        <button class="btn danger" id="delete-all-audit" style="min-width:0;height:44px;padding:0 18px;">Удалить все файлы проекта</button>
      </div>
    </div>
  </div><!-- /group-audit -->

  <!-- ============ SMM-ИНСТРУМЕНТЫ ============ -->
  <div class="group" id="group-smm" data-group="smm">
    <div class="tabs" role="tablist">
      <button class="tab active" data-tab="smm-groups-tool"><span class="t-num">1</span> Анализ групп</button>
      <button class="tab" data-tab="smm-results" data-results-tab="1"><span class="t-num">2</span> Результаты SMM</button>
    </div>

    <section class="tab-panel show" id="panel-smm-groups-tool">
      <div class="card">
        <h2><span>1</span> Анализ групп</h2>
        <p class="sub">Сбор статистики по опубликованным постам в группах и каналах <b>ВКонтакте</b>, <b>Telegram</b> и <b>MAX</b> за выбранный период (навык <code>smm-groups</code>). Результат — таблица <code>.xlsx</code>.</p>

        <label class="field" for="smm-groups">Группы для анализа *</label>
        <textarea id="smm-groups" rows="5" placeholder="По одной ссылке на строку:&#10;https://vk.com/frontside&#10;https://t.me/frontside&#10;https://max.ru/frontside&#10;Можно смешивать площадки в одном списке."></textarea>
        <div class="file-hint" style="margin-top:-8px">Каждая строка — одна группа/канал. Поддерживаются ссылки ВКонтакте, Telegram и MAX; площадки можно указывать вместе. Идентификатор (например <code>vk.com/frontside</code>) тоже подойдёт.</div>

        <div class="field" style="margin-top:10px;">Период анализа *</div>
        <div class="period-row">
          <div class="period-col">
            <label class="field" for="smm-date-from">С даты</label>
            <input type="date" id="smm-date-from">
          </div>
          <div class="period-col">
            <label class="field" for="smm-date-to">По дату</label>
            <input type="date" id="smm-date-to">
          </div>
        </div>
        <div class="period-hint">Выбери диапазон дат, например <b>2026-08-01</b> — <b>2026-09-25</b>. Собираются все посты, опубликованные в этот период включительно. Если оставить пустым — возьмётся последние 30 дней.</div>

        <label class="field" for="smm-account" style="margin-top:6px;">Аккаунт для входа <small style="color:var(--muted)">(необязательно)</small></label>
        <input type="text" id="smm-account" placeholder="телефон / логин">
        <div class="file-hint" style="margin-top:-10px">Подставится в окно авторизации ВКонтакте/Telegram/MAX, если требуется вход (закрытые группы, полная статистика).</div>

        <button class="btn" id="run-smm-groups">Запустить проверку</button>
        <div class="status" id="status-smm-groups"></div>
      </div>
      <div class="summary">
        <b>Как это работает</b>
        <ol>
          <li>Введи группы/каналы — по одной ссылке на строку (можно смешивать ВКонтакте, Telegram и MAX).</li>
          <li>Выбери период анализа — посты, опубликованные в этом диапазоне, попадут в отчёт.</li>
          <li>При необходимости укажи аккаунт — он подставится в окно входа, если нужен доступ к закрытой группе или к полной статистике.</li>
          <li>Нажми «Запустить проверку» — навык <code>smm-groups</code> заходит в группы и проходит по опубликованным постам ленты за указанный период.</li>
          <li>По каждому посту собираются поля: <code>Ссылка на пост</code>, <code>Дата публикации</code>, <code>Лайки</code>, <code>Репосты</code>, <code>Голоса</code>, <code>Комментарии</code>, <code>Просмотры всего</code>, <code>Переходы по ссылкам</code>, <code>Количество отписавшихся</code>, <code>Количество подписавшихся</code>, <code>Просмотры подписчики</code>, <code>Просмотры не подписчики</code>, <code>Хештег поста</code>, <code>Текст поста (без хештега)</code>.</li>
          <li>Если площадка не отдаёт часть статистики (например, в MAX её почти нет) — колонки остаются, а недоступные значения пустыми. Посты не пропускаются.</li>
          <li>Готовый файл <code>SMM_группы_&lt;проект&gt;.xlsx</code> появится на вкладке «Результаты SMM».</li>
        </ol>
      </div>
    </section>

    <section class="tab-panel" id="panel-smm-results">
      <div class="card">
        <h2><span>2</span> Результаты SMM</h2>
        <p class="sub">Таблицы <code>.xlsx</code>/<code>.csv</code> по анализу групп из папки <code>seo-results/&lt;проект&gt;/&lt;дата_время&gt;/</code>.</p>
        <label class="field" for="smm-project">Проект</label>
        <div class="inline-row">
          <select id="smm-project" class="project-select">
            <option value="">— выбери проект —</option>
          </select>
          <button class="btn ghost" id="refresh-smm-results" style="flex:0 0 auto;min-width:0;height:44px;padding:0 18px;">Обновить</button>
        </div>
        <div id="smm-results-list"><p style="color:var(--muted);font-size:14px;">Загрузка…</p></div>
        <div style="margin-top:16px;display:flex;justify-content:flex-end;">
          <button class="btn danger" id="delete-all-smm" style="min-width:0;height:44px;padding:0 18px;">Удалить все файлы проекта</button>
        </div>
      </div>
      <div class="summary">
        <b>Как это работает</b>
        <ol>
          <li>Выбери проект в списке — появятся папки запусков анализа групп.</li>
          <li>Нажми «Обновить», если появились новые таблицы.</li>
          <li>В списке появятся <code>.xlsx</code>/<code>.csv</code> с постами и метриками.</li>
          <li>Кнопками можно посмотреть предпросмотр (CSV), скачать или удалить файл.</li>
          <li>Кнопка «Удалить все файлы проекта» очищает все запуски выбранного проекта.</li>
        </ol>
      </div>
    </section>
  </div><!-- /group-smm -->

  <!-- Модалка предпросмотра -->
  <div class="modal-overlay" id="preview-overlay">
    <div class="modal">
      <div class="modal-head">
        <b id="preview-title"></b>
        <span class="modal-close" id="preview-close">✕</span>
      </div>
      <div class="modal-body" id="preview-body"></div>
      <div class="modal-foot">
        <a class="btn ghost" id="preview-download" href="#" download>Скачать файл</a>
      </div>
    </div>
  </div>

  <footer>Сервер плагина opencode · <span id="foot-server">http://localhost:${port}</span><br><small style="color:var(--muted)">Доступ из локальной сети: <code>${lanUrl}</code></small>
  <div id="tracker-status" style="margin-top:10px;font-size:12px;color:var(--muted)"></div>
  ${authEnabled() ? `<div style="margin-top:8px;font-size:12px;color:var(--muted)">${auth ? (auth.role === "it" ? "Вы вошли как <b style=\"color:var(--text)\">IT-администратор</b> — доступны логи и бэкапы." : (auth.role === "admin" ? "Вы вошли как <b style=\"color:var(--text)\">администратор</b> — видны все проекты." : "Вы вошли как сотрудник <b style=\"color:var(--text)\">" + auth.uid + "</b> — видны только ваши результаты.")) : ""}${auth ? " · " : ""}<a href="/logout" style="color:var(--muted)">Выйти</a></div>` : ""}
  </footer>
</div>

<script>
const serverUrl = window.location.origin;

// ---------- Переключение темы (тёмная / светлая) ----------
const themeBtn = document.getElementById('theme-toggle');
function applyTheme(t){
  t = t === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  if(themeBtn){
    const lbl = themeBtn.querySelector('.tt-label');
    if(lbl) lbl.textContent = t === 'light' ? 'Светлая тема' : 'Тёмная тема';
    themeBtn.setAttribute('aria-pressed', String(t === 'light'));
  }
  try{ localStorage.setItem('seo-theme', t); }catch(e){}
}
applyTheme(document.documentElement.getAttribute('data-theme'));
if(themeBtn) themeBtn.addEventListener('click', ()=> applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'));

function styleCheck(label){
  const box = label.querySelector('input');
  const upd = () => label.classList.toggle('checked', box.checked);
  box.addEventListener('change', upd);
  upd();
}
document.querySelectorAll('.check').forEach(styleCheck);

// ---------- Табы (группы верхнего уровня) ----------
function switchGroup(name){
  document.querySelectorAll('.gtab').forEach(b=>b.classList.toggle('active', b.dataset.group === name));
  document.querySelectorAll('.group').forEach(g=>g.classList.toggle('show', g.dataset.group === name));
}
document.querySelectorAll('.gtab').forEach(b=>b.addEventListener('click', ()=>switchGroup(b.dataset.group)));

function switchTab(name){
  const tab = document.querySelector('.tab[data-tab="' + name + '"]');
  if(!tab) return;
  const group = tab.closest('.group');
  switchGroup(group ? group.dataset.group : 'tools');
  group.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.tab === name));
  group.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('show', p.id === 'panel-' + name));
}
// Вкладка результатов скрыта, пока в её группе не завершится хотя бы одно задание.
// Открывается по факту готовности задания (или если результаты уже есть в папке проекта).
function revealResultsTab(name){
  if(!name) return;
  const t = document.querySelector('.tab[data-tab="' + name + '"]');
  if(t) t.classList.remove('tab-hidden');
}
document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click', ()=>switchTab(b.dataset.tab)));

function setStatus(id, kind, html){
  const el = document.getElementById(id);
  el.removeAttribute('data-task');
  if(!kind){ el.className='status'; el.textContent=''; return; }
  el.className = 'status show ' + kind;
  el.innerHTML = html;
}

function disableBtn(id, on){
  document.getElementById(id).disabled = on;
}

async function post(url, body){
  const res = await fetch(url, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(()=>({ok:false, error:'Не удалось прочитать ответ'}));
  if(!res.ok || !data.ok){
    throw new Error(data.error || ('HTTP ' + res.status));
  }
  return data;
}

const CATS = {
  all: 'Все задачи', extract: 'Выгрузка метатегов', metatags: 'Метатеги',
  wordstat: 'Wordstat', topics: 'Темы статей', articles: 'Статьи',
  microdata: 'Микроразметка', audit: 'Аудит', smm: 'SMM', other: 'Прочее'
};
function escAttr(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function renderTask(el, task){
  if(!task) return;
  const running = task.status === 'running';
  const err = task.status === 'error';
  const cancelled = task.status === 'cancelled';
  const progClass = running ? 'running' : (err ? 'error' : (cancelled ? 'cancelled' : 'done'));
  const pct = (running ? (task.pct || 0) : 100);
  const stageLabel = (task.stage && task.stagesTotal) ? ('этап ' + task.stage + '/' + task.stagesTotal) : '';
  let html = '<b>' + esc(task.label || 'Задание') + '</b>';
  html += '<div class="task-pct">' + pct + '%' + (stageLabel ? ' · ' + stageLabel : '') + '</div>';
  html += '<div class="progress ' + progClass + '" data-pct="' + pct + '" data-target="' + pct + '" data-stage="' + escAttr(stageLabel) + '"><i style="width:' + pct + '%"></i></div>';
  html += '<div class="task-msg">' + esc(task.message || '') + '</div>';
  html += '<div class="task-actions">';
  if(running){
    html += '<button class="btn ghost task-cancel" data-task-id="' + escAttr(task.id) + '">Отмена</button>';
  }else{
    if(err || cancelled){
      html += '<button class="btn ghost task-reset">Понятно</button>';
    }else if(task.host){
      revealResultsTab(task.tab || 'results');
      html += '<button class="btn ghost task-open" data-host="' + escAttr(task.host) + '" data-tab="' + escAttr(task.tab || 'results') + '">Открыть результаты</button>';
    }
  }
  html += '</div>';
  el.classList.remove('show','ok','err','wait');
  el.classList.add('show', err ? 'err' : (running ? 'wait' : 'ok'));
  el.innerHTML = html;
}

let _lastStageKey = '';
// Мягкий визуальный «доводчик»: плавно подтягивает полосу к концу ТЕКУЩЕГО этапа,
// но НИКОГДА не перескакивает на следующий этап (данные об этапах приходят с сервера).
// Если этапы ещё не начали поступать — полоса стоит на 0, а не выдумывает рост.
function tickProgress(){
  document.querySelectorAll('.status[data-task]').forEach(el=>{
    const taskId = el.getAttribute('data-task');
    if(!taskId) return;
    const bar = el.querySelector('.progress');
    if(!bar || !bar.classList.contains('running')) return;
    const target = parseInt(bar.getAttribute('data-target') || '0', 10);
    const cur = parseInt(bar.getAttribute('data-pct') || '0', 10);
    if(cur >= target) return; // не превышаем реальный этап
    const next = Math.min(cur + 1, target);
    bar.setAttribute('data-pct', String(next));
    const i = bar.querySelector('i');
    if(i) i.style.width = next + '%';
    const p = el.querySelector('.task-pct');
    if(p){
      const st = bar.getAttribute('data-stage');
      p.textContent = next + '%' + (st ? ' · ' + st : '');
    }
  });
}
setInterval(tickProgress, 700);

// Плавное «подтягивание» внутри текущего этапа: раз в секунду мягко сдвигаем
// data-target к границе этапа (не более +2% за тик), чтобы полоса не замирала,
// но оставалась привязанной к этапу. Скачок на новый этап задаёт сервер.
setInterval(()=>{
  document.querySelectorAll('.status[data-task] .progress.running').forEach(bar=>{
    const pct = parseInt(bar.getAttribute('data-pct') || '0', 10);
    const stage = bar.getAttribute('data-stage') || '';
    const m = /этап\\s+(\\d+)\\/(\\d+)/.exec(stage);
    if(!m) return;
    const curStage = parseInt(m[1], 10);
    const nextBoundary = Math.round((curStage / parseInt(m[2], 10)) * 100);
    const target = parseInt(bar.getAttribute('data-target') || '0', 10);
    // тянем цель вверх к текущей границе, но не выше неё и не больше +2 за раз
    if(target < nextBoundary) bar.setAttribute('data-target', String(Math.min(nextBoundary, target + 2)));
    if(pct >= nextBoundary) return;
  });
}, 1000);

async function cancelTask(btn){
  const taskId = btn.getAttribute('data-task-id');
  btn.disabled = true;
  btn.textContent = 'Отменяю…';
  try{
    const res = await fetch('/api/tasks/cancel', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ id: taskId })
    });
    const data = await res.json().catch(()=>({ok:false, error:'Не удалось прочитать ответ'}));
    if(!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    const el = btn.closest('.status');
    if(el && taskId) renderTask(el, { id: taskId, label: btn.closest('.status').querySelector('b')?.textContent || 'Задание', status:'cancelled', message:'Задание отменено' });
  }catch(e){
    btn.disabled = false;
    btn.textContent = 'Отмена';
    alert('Ошибка при отмене: ' + e.message);
  }
}
window.cancelTask = cancelTask;

function bindTask(statusId, taskId, label, host, tab){
  const el = document.getElementById(statusId);
  if(!taskId){ el.removeAttribute('data-task'); return; }
  el.setAttribute('data-task', taskId);
  renderTask(el, { id: taskId, label: label, status: 'running', message: 'Задание отправлено в opencode…', host: host, tab: tab });
}

async function pollTasks(){
  let res;
  try { res = await fetch('/api/tasks'); } catch(e){ return; }
  const data = await res.json().catch(()=>null);
  if(!data || !data.ok || !Array.isArray(data.tasks)) return;
  const byId = {};
  data.tasks.forEach(t=>byId[t.id]=t);
  document.querySelectorAll('[data-task]').forEach(el=>{
    const id = el.getAttribute('data-task');
    if(id && byId[id]){
      const prev = el.querySelector('.progress');
      const prevPct = prev ? parseInt(prev.getAttribute('data-pct') || '0', 10) : 0;
      const t = byId[id];
      // Реальный процент этапа с сервера; не даём полосе откатываться назад
      // и сохраняем «доводчик» до текущего этапа.
      if(t.status === 'running'){
        const serverPct = (typeof t.pct === 'number' ? t.pct : 0);
        const shown = Math.max(serverPct, Math.min(prevPct, serverPct));
        t.pct = serverPct;
        renderTask(el, t);
        const bar = el.querySelector('.progress');
        if(bar){
          bar.setAttribute('data-target', String(serverPct));
          bar.setAttribute('data-pct', String(shown));
          bar.setAttribute('data-stage', t.stage && t.stagesTotal ? ('этап ' + t.stage + '/' + t.stagesTotal) : '');
        }
      }else{
        renderTask(el, t);
      }
    }
  });
}
setInterval(pollTasks, 1200);

function openResults(host, tab){
  revealResultsTab(tab || 'results');
  if(tab === 'a-results'){
    switchGroup('audit');
    if(typeof window.showAuditResults === 'function'){ window.showAuditResults(host); }
    return;
  }
  selectProject(host);
  switchTab(tab || 'results');
}
function resetTask(btn){
  const el = btn.closest('.status');
  if(el){ el.removeAttribute('data-task'); el.className='status'; el.innerHTML=''; }
}
window.openResults = openResults;
window.resetTask = resetTask;

document.addEventListener('click', (e)=>{
  const open = e.target.closest('.task-open');
  if(open){ openResults(open.dataset.host, open.dataset.tab || 'results'); return; }
  const reset = e.target.closest('.task-reset');
  if(reset) resetTask(reset);
  const cancel = e.target.closest('.task-cancel');
  if(cancel) cancelTask(cancel);
});

// ---------- Выгрузка ----------
document.getElementById('run-extract').addEventListener('click', async () => {
  const url = document.getElementById('extract-url').value.trim();
  const checks = [...document.querySelectorAll('#extract-checks input:checked')].map(c=>c.value);
  const status = document.getElementById('status-extract');

  if(!url){ setStatus('status-extract','err','<b>Ошибка</b> Укажи URL сайта.'); return; }
  if(checks.length===0){ setStatus('status-extract','err','<b>Ошибка</b> Выбери хотя бы один элемент для выгрузки.'); return; }

  disableBtn('run-extract', true);
  setStatus('status-extract','wait','<b>Отправка задания в opencode…</b>');
  try{
    const data = await post('/run-extract', { url, checks });
    if(data.host){ selectProject(data.host); }
    bindTask('status-extract', data.taskId, 'Выгрузка метатегов — ' + url, data.host);
  }catch(e){
    setStatus('status-extract','err','<b>Ошибка</b> ' + e.message);
  }finally{
    disableBtn('run-extract', false);
  }
});

// ---------- Микроразметка ----------
document.getElementById('run-microdata').addEventListener('click', async () => {
  const url = document.getElementById('md-url').value.trim();

  if(!url){ setStatus('status-microdata','err','<b>Ошибка</b> Укажи URL сайта.'); return; }

  disableBtn('run-microdata', true);
  setStatus('status-microdata','wait','<b>Отправка задания в opencode…</b>');
  try{
    const data = await post('/run-microdata', { url });
    if(data.host){ selectProject(data.host); }
    bindTask('status-microdata', data.taskId, 'Аудит микроразметки — ' + url, data.host);
  }catch(e){
    setStatus('status-microdata','err','<b>Ошибка</b> ' + e.message);
  }finally{
    disableBtn('run-microdata', false);
  }
});

// ---------- Составление мета ----------
const MAX_FILE_MB = 50;
const dz = document.getElementById('dropzone-core');
const dzInput = document.getElementById('core-file');
const dzText = document.getElementById('dz-text');
const dzChosen = document.getElementById('dz-chosen');
const dzErr = document.getElementById('dz-err');
let chosenFile = null;

function resetDz(){
  chosenFile = null;
  dzInput.value = '';
  dzText.textContent = 'Перетащи файл сюда или выбери его';
  dzChosen.classList.remove('show');
  dzErr.classList.remove('show');
}

function setDzFile(file){
  if(!file) return;
  const okExt = /\\.(xlsx|xls|csv)$/i.test(file.name);
  const okSize = file.size <= MAX_FILE_MB * 1024 * 1024;
  if(!okExt || !okSize){ dzErr.classList.add('show'); resetDz(); return; }
  dzErr.classList.remove('show');
  chosenFile = file;
  dzText.textContent = 'Файл готов';
  dzChosen.innerHTML = 'Выбран: <b>' + esc(file.name) + '</b> (' + (file.size/1024/1024).toFixed(2) + ' МБ) <span class="dz-clear">✕ убрать</span>';
  dzChosen.classList.add('show');
  dzChosen.querySelector('.dz-clear').addEventListener('click', resetDz);
}

['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault(); dz.classList.add('over');}));
['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault(); dz.classList.remove('over');}));
dz.addEventListener('drop', e=>{
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if(f) setDzFile(f);
});
dzInput.addEventListener('change', ()=>{
  if(dzInput.files && dzInput.files[0]) setDzFile(dzInput.files[0]);
});

document.getElementById('run-metatags').addEventListener('click', async () => {
  const metaUrl = document.getElementById('meta-url').value.trim();
  const status = document.getElementById('status-metatags');

  if(!chosenFile){
    setStatus('status-metatags','err','<b>Ошибка</b> Загрузи файл семантического ядра (.xlsx/.xls/.csv) — без него навык не запустится.');
    return;
  }
  if(!metaUrl){
    setStatus('status-metatags','err','<b>Ошибка</b> Укажи URL сайта (проверяемый проект).');
    return;
  }

  disableBtn('run-metatags', true);
  setStatus('status-metatags','wait','<b>Файл загружается и задание отправляется в opencode…</b>');
  try{
    const fd = new FormData();
    fd.append('file', chosenFile);
    fd.append('newMeta', '1');
    fd.append('metaUrl', metaUrl);
    const res = await fetch('/run-metatags', { method:'POST', body: fd });
    const j = await res.json().catch(()=>({ok:false, error:'Не удалось прочитать ответ'}));
    if(!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
    if(j.host){ selectProject(j.host); }
    bindTask('status-metatags', j.taskId, 'Метатеги по семядру — ' + metaUrl, j.host);
  }catch(e){
    setStatus('status-metatags','err','<b>Ошибка</b> ' + e.message);
  }finally{
    disableBtn('run-metatags', false);
  }
});

// ---------- Wordstat ----------
(() => {
  const wsQueries = document.getElementById('ws-queries');
  const wsRegions = document.getElementById('ws-regions');
  const wsRegionFilter = document.getElementById('ws-region-filter');
  let allRegions = [];

  const renderRegions = (filter) => {
    filter = (filter || '').trim().toLowerCase();
    const matched = allRegions.filter(r => !filter || r.name.toLowerCase().indexOf(filter) === 0);
    if(!matched.length){
      wsRegions.innerHTML = '<div style="color:var(--muted);font-size:13px;">Ничего не найдено по запросу «' + esc(filter || '') + '». Попробуй иначе.</div>';
      return;
    }
    wsRegions.innerHTML = matched.map((r)=>(
      '<label class="check"><input type="radio" name="ws-region" value="' + esc(r.id) + '" data-name="' + esc(r.name) + '"><span>' + esc(r.name) + '</span></label>'
    )).join('') + '<label class="check checked"><input type="radio" name="ws-region" value="all" data-name="Все регионы" checked><span>Все регионы</span></label>';
    wsRegions.querySelectorAll('.check').forEach(styleCheck);
    wsRegions.scrollTop = 0;
  };

  const loadRegions = async () => {
    try{
      const res = await fetch('/api/wordstat/regions');
      const j = await res.json();
      if(!j.ok) throw new Error(j.error || 'no data');
      allRegions = j.regions || [];
      if(!allRegions.length){ wsRegions.innerHTML = '<div style="color:var(--muted);font-size:13px;">Регионы не получены — укажи регион вручную в промпте.</div>'; return; }
      renderRegions('');
    }catch(e){
      wsRegions.innerHTML = '<div style="color:var(--danger);font-size:13px;">Не удалось загрузить регионы: ' + esc(String(e)) + '</div>';
    }
  };

  wsRegionFilter.addEventListener('input', () => renderRegions(wsRegionFilter.value));

  document.getElementById('run-wordstat').addEventListener('click', async () => {
    const queries = wsQueries.value.split(/\\r?\\n/).map(s=>s.trim()).filter(Boolean);
    const checkedRegion = document.querySelector('input[name="ws-region"]:checked') || {};
    const regionId = checkedRegion.value || 'all';
    const regionName = checkedRegion.dataset && checkedRegion.dataset.name ? checkedRegion.dataset.name : 'Все регионы';
    const periodFrom = document.getElementById('ws-period-from').value;
    const periodTo = document.getElementById('ws-period-to').value;
    const period = periodFrom && periodTo ? ('с ' + periodFrom + ' по ' + periodTo) : 'последний год';
    const device = (document.querySelector('input[name="ws-device"]:checked') || {}).value || 'десктопы';
    const breakRaw = (document.querySelector('input[name="ws-break"]:checked') || {}).value || 'month';
    const breakMap = { month: 'по месяцам', week: 'по неделям', day: 'по дням' };
    const breakLabel = breakMap[breakRaw] || 'по месяцам';
    const account = document.getElementById('ws-account').value.trim();
    const status = document.getElementById('status-wordstat');

    if(!queries.length){ setStatus('status-wordstat','err','<b>Ошибка</b> Вставь хотя бы один запрос.'); return; }

    disableBtn('run-wordstat', true);
    setStatus('status-wordstat','wait','<b>Отправка задания в opencode…</b>');
    try{
      const data = await post('/run-wordstat', { queries, regionId, regionName, period, device, breakRaw, breakLabel, account });
      bindTask('status-wordstat', data.taskId, 'Wordstat — ' + queries.length + ' запросов', null);
    }catch(e){
      setStatus('status-wordstat','err','<b>Ошибка</b> ' + e.message);
    }finally{
      disableBtn('run-wordstat', false);
    }
  });

  loadRegions();
})();
// ---------- Генерация тем ----------
document.getElementById('run-topics').addEventListener('click', async () => {
  const url = document.getElementById('tp-url').value.trim();
  const competitors = document.getElementById('tp-competitors').value.split(/\\r?\\n/).map(s=>s.trim()).filter(Boolean);
  const countRaw = document.getElementById('tp-count').value.trim();
  const count = Math.max(1, Math.min(50, parseInt(countRaw, 10) || 10));
  const account = document.getElementById('tp-account').value.trim();
  const status = document.getElementById('status-topics');

  if(!url){ setStatus('status-topics','err','<b>Ошибка</b> Укажи URL сайта.'); return; }

  disableBtn('run-topics', true);
  setStatus('status-topics','wait','<b>Отправка задания в opencode…</b>');
  try{
    const data = await post('/run-topics', { url, competitors, account, count });
    if(data.host){ selectProject(data.host); }
    bindTask('status-topics', data.taskId, 'Темы статей — ' + url, data.host);
  }catch(e){
    setStatus('status-topics','err','<b>Ошибка</b> ' + e.message);
  }finally{
    disableBtn('run-topics', false);
  }
});

// ---------- Статьи ----------
(() => {
  const arTopicsPath = document.getElementById('ar-topics-path');
  const tzDrop = document.getElementById('dropzone-tz');
  const tzInput = document.getElementById('tz-file');
  const tzText = document.getElementById('tz-text');
  const tzSub = document.getElementById('tz-sub');
  const tzChosen = document.getElementById('tz-chosen');
  const tzErr = document.getElementById('tz-err');
  const arType = document.getElementById('ar-type');
  const commBlock = document.getElementById('ar-commercial-block');
  const urlLabel = document.getElementById('ar-url-label');
  const urlHint = document.getElementById('ar-url-hint');
  const countWrap = document.getElementById('ar-count-wrap');
  const srcFileCheck = document.getElementById('ar-src-file-check');
  const srcTopicsCheck = document.getElementById('ar-src-topics-check');
  const topicsLabel = document.getElementById('ar-topics-label');
  const topicsHint = document.getElementById('ar-topics-hint');
  const srcFileRadio = document.querySelector('input[name="ar-source"][value="file"]');
  const srcTopicsRadio = document.querySelector('input[name="ar-source"][value="topics"]');
  let chosenTz = null;

  const isCommercial = () => arType.value === 'commercial';

  const applySource = () => {
    if(isCommercial()) return;
    const useFile = srcFileRadio.checked;
    tzDrop.style.display = useFile ? 'block' : 'none';
    topicsLabel.style.display = useFile ? 'none' : 'block';
    if(topicsHint) topicsHint.style.display = useFile ? 'none' : 'block';
    arTopicsPath.style.display = useFile ? 'none' : 'block';
    const tpFilters = document.getElementById('ar-topics-filters');
    if(tpFilters) tpFilters.style.display = useFile ? 'none' : 'flex';
    // при переключении на «по темам» обновляем список документов
    if(!useFile) loadTopicDocs();
  };

  const applyMode = () => {
    const commercial = isCommercial();
    commBlock.style.display = commercial ? 'block' : 'none';
    countWrap.style.display = commercial ? 'none' : 'block';
    srcFileCheck.style.display = commercial ? 'none' : 'flex';
    srcTopicsCheck.style.display = commercial ? 'none' : 'flex';
    urlLabel.textContent = commercial ? 'URL коммерческой страницы *' : 'URL сайта (для кого пишем) *';
    urlHint.textContent = commercial
      ? 'Навык откроет эту страницу, разберёт tone of voice и подачу, а фактуру возьмёт с других разделов сайта (главная, «О компании»).'
      : 'Навык проверит сайт и сформирует бренд-контекст для компании и статей.';
    if(commercial){
      tzDrop.style.display = 'block';
      topicsLabel.style.display = 'none';
      if(topicsHint) topicsHint.style.display = 'none';
      arTopicsPath.style.display = 'none';
      const tpFilters = document.getElementById('ar-topics-filters');
      if(tpFilters) tpFilters.style.display = 'none';
      tzSub.textContent = 'Необязательно: прикрепи ТЗ (структура, ключи, требования), если оно есть.';
    }else{
      tzSub.textContent = '.xlsx / .csv / .json / .txt — навык проверит темы, структуру и ключевые слова';
      applySource();
    }
  };

  srcFileRadio.addEventListener('change', applySource);
  srcTopicsRadio.addEventListener('change', applySource);
  arType.addEventListener('change', applyMode);
  srcFileRadio.checked = true;
  applyMode();

  function resetTz(){
    chosenTz = null;
    tzInput.value = '';
    tzText.textContent = 'Перетащи файл ТЗ сюда или выбери его';
    tzChosen.classList.remove('show');
    tzErr.classList.remove('show');
  }
  function setTzFile(file){
    if(!file) return;
    const okSize = file.size <= 50 * 1024 * 1024;
    if(!okSize){ tzErr.classList.add('show'); resetTz(); return; }
    tzErr.classList.remove('show');
    chosenTz = file;
    tzText.textContent = 'Файл готов';
    tzChosen.innerHTML = 'Выбран: <b>' + esc(file.name) + '</b> (' + (file.size/1024/1024).toFixed(2) + ' МБ) <span class="dz-clear">✕ убрать</span>';
    tzChosen.classList.add('show');
    tzChosen.querySelector('.dz-clear').addEventListener('click', resetTz);
  }
  ['dragenter','dragover'].forEach(ev=>tzDrop.addEventListener(ev,e=>{e.preventDefault(); tzDrop.classList.add('over');}));
  ['dragleave','drop'].forEach(ev=>tzDrop.addEventListener(ev,e=>{e.preventDefault(); tzDrop.classList.remove('over');}));
  tzDrop.addEventListener('drop', e=>{ const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if(f) setTzFile(f); });
  tzInput.addEventListener('change', ()=>{ if(tzInput.files && tzInput.files[0]) setTzFile(tzInput.files[0]); });

  // список документов с темами (только Темы_для_блога_*.xlsx) с фильтрами по сайту/периоду
  const arTpSite = document.getElementById('ar-tp-site');
  const arTpYear = document.getElementById('ar-tp-year');
  const arTpMonth = document.getElementById('ar-tp-month');
  const arTpReset = document.getElementById('ar-tp-reset');
  let topicDocsCache = [];

  async function loadTopicDocs(){
    const projects = await fetchProjects('');
    topicDocsCache = [];
    projects.forEach(p => p.dates.forEach(d => d.files.forEach(f => {
      if(/Темы_для_блога/i.test(f.name) && /\\.(xlsx|xls)$/i.test(f.name)) {
        topicDocsCache.push({ name: f.name, path: f.path, host: p.host, date: d.date || '', time: d.time || '' });
      }
    })));
    // опции фильтра «Сайт»
    const sites = [...new Set(topicDocsCache.map(d=>d.host))].sort();
    const curSite = arTpSite.value;
    arTpSite.innerHTML = '<option value="">Все сайты</option>' + sites.map(s=>'<option value="'+esc(s)+'">'+esc(s)+'</option>').join('');
    if(curSite && sites.includes(curSite)) arTpSite.value = curSite;
    // опции фильтра «Год»
    const years = [...new Set(topicDocsCache.map(d=>d.date.slice(0,4)).filter(Boolean))].sort().reverse();
    const curYear = arTpYear.value;
    arTpYear.innerHTML = '<option value="">Все годы</option>' + years.map(y=>'<option value="'+esc(y)+'">'+esc(y)+'</option>').join('');
    if(curYear && years.includes(curYear)) arTpYear.value = curYear;
    renderTopicDocs();
  }

  function renderTopicDocs(){
    const host = arTpSite.value;
    const year = arTpYear.value;
    const month = arTpMonth.value;
    const prev = arTopicsPath.value;
    const filtered = topicDocsCache.filter(d => {
      if(host && d.host !== host) return false;
      const dm = d.date ? d.date.slice(0,7) : '';
      if(year && dm.slice(0,4) !== year) return false;
      if(month && dm.slice(5,7) !== month) return false;
      return true;
    }).sort((a,b)=> (b.date + b.time).localeCompare(a.date + a.time));
    arTopicsPath.innerHTML = '<option value="">— выбери документ —</option>' + filtered.map(d => {
      const stamp = d.date ? (d.date + (d.time ? ' ' + fmtShortTime(d.time) : '')) : '';
      const label = d.host + (stamp ? ' · ' + stamp : '') + ' · ' + d.name;
      return '<option value="' + esc(d.path) + '">' + esc(label) + '</option>';
    }).join('');
    if(filtered.some(d=>d.path===prev)) arTopicsPath.value = prev;
  }

  function fmtShortTime(t){ const s=String(t||''); return s.includes(':') ? s.slice(0,5) : s.replace(/(\\d{2})(\\d{2})(\\d{2})/, '$1:$2'); }

  [arTpSite, arTpYear, arTpMonth].forEach(el=>{ if(el) el.addEventListener('change', renderTopicDocs); });
  if(arTpReset) arTpReset.addEventListener('click', ()=>{
    arTpSite.value=''; arTpYear.value=''; arTpMonth.value=''; renderTopicDocs();
  });
  loadTopicDocs();

  document.getElementById('run-articles').addEventListener('click', async () => {
    const url = document.getElementById('ar-url').value.trim();
    const notes = document.getElementById('ar-notes').value.trim();
    const countRaw = document.getElementById('ar-count').value.trim();
    const count = Math.max(1, Math.min(50, parseInt(countRaw, 10) || 10));
    const status = document.getElementById('status-articles');
    const materialType = arType.value;
    const commercial = materialType === 'commercial';
    const commercialMode = (document.querySelector('input[name="ar-comm-mode"]:checked') || {}).value || 'new';
    const useFile = commercial ? false : srcFileRadio.checked;
    const topicsPath = useFile ? '' : arTopicsPath.value;

    if(!url){ setStatus('status-articles','err','<b>Ошибка</b> Укажи ' + (commercial ? 'URL коммерческой страницы.' : 'URL сайта.')); return; }
    if(!commercial){
      if(useFile && !chosenTz){ setStatus('status-articles','err','<b>Ошибка</b> Выбери файл ТЗ.'); return; }
      if(!useFile && !topicsPath){ setStatus('status-articles','err','<b>Ошибка</b> Выбери документ со сгенерированными темами.'); return; }
    }

    disableBtn('run-articles', true);
    setStatus('status-articles','wait','<b>Файл загружается и задание отправляется в opencode…</b>');
    try{
      let data;
      if(commercial || useFile){
        const fd = new FormData();
        fd.append('url', url);
        if(chosenTz) fd.append('file', chosenTz);
        fd.append('notes', notes);
        fd.append('count', String(count));
        fd.append('materialType', materialType);
        fd.append('commercialMode', commercialMode);
        const res = await fetch('/run-articles', { method:'POST', body: fd });
        const j = await res.json().catch(()=>({ok:false, error:'Не удалось прочитать ответ'}));
        if(!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
        data = j;
      }else{
        data = await post('/run-articles', { url, topicsPath, notes, count, materialType, commercialMode });
      }
      if(data.host){ selectProject(data.host); }
      const label = commercial
        ? ('Коммерческий текст (' + (commercialMode === 'rewrite' ? 'рерайт' : 'новый') + ') — ' + url)
        : ('Статьи — ' + url);
      bindTask('status-articles', data.taskId, label, data.host);
    }catch(e){
      setStatus('status-articles','err','<b>Ошибка</b> ' + e.message);
    }finally{
      disableBtn('run-articles', false);
    }
  });
})();

// ---------- Статьи: правки в готовые тексты ----------
(() => {
  function hostOf(u){
    let s = String(u || '').trim().toLowerCase();
    s = s.replace('https://', '').replace('http://', '');
    const slash = s.indexOf('/');
    if (slash >= 0) s = s.slice(0, slash);
    const at = s.indexOf('@');
    if (at >= 0) s = s.slice(at + 1);
    return s;
  }

  async function revise(btn){
    const wrap = btn.closest('.edit-box');
    const file = btn.getAttribute('data-path');
    const st = wrap.querySelector('.edit-status');
    const ta = wrap.querySelector('textarea');
    const instruction = (ta && ta.value || '').trim();
    if(!instruction){ st.className='status err show'; st.innerHTML='<b>Ошибка</b> Напиши, что поправить.'; return; }
    btn.disabled = true; st.className='status wait show'; st.innerHTML='<b>Отправляю правки в opencode…</b>';
    try{
      const res = await fetch('/api/revise', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ file: file, instruction: instruction })
      });
      const data = await res.json().catch(()=>({ok:false, error:'Не удалось прочитать ответ'}));
      if(!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      st.className='status ok show'; st.innerHTML='<b>Правки отправлены.</b> Файл обновится после обработки — проверь в «Результатах».';
    }catch(e){ st.className='status err show'; st.innerHTML='<b>Ошибка</b> '+esc(e && e.message); }
    finally{ btn.disabled = false; }
  }

  async function loadEdits(){
    const list = document.getElementById('edits-list');
    const host = hostOf(document.getElementById('ar-url').value);
    if(!host){ list.innerHTML = '<p class="r-empty">Укажи URL сайта выше.</p>'; return; }
    list.innerHTML = '<p class="r-empty">Загрузка…</p>';
    try{
      const res = await fetch('/api/projects?host=' + encodeURIComponent(host));
      const data = await res.json();
      const proj = (data.projects||[])[0];
      const files = [];
      (proj ? proj.dates : []).forEach(d => d.files.forEach(f => {
        if(f.category === 'articles' && f.ext === '.docx') files.push(f);
      }));
      if(!files.length){ list.innerHTML = '<p class="r-empty">По этому сайту пока нет текстов (.docx).</p>'; return; }
      list.innerHTML = files.map(f =>
        '<div class="r-item" style="display:block;">'
        + '<div class="r-info"><div class="r-name">'+esc(f.name)+'</div>'
        + '<div class="r-meta">'+esc(f.sizeHuman)+' · '+fmtTime(f.mtime*1000)+'</div></div>'
        + '<details class="edit-box" style="margin-top:10px;">'
        + '<summary style="cursor:pointer;color:var(--accent);font-size:13px;font-weight:600;">Правки</summary>'
        + '<textarea rows="3" placeholder="Например: сократи на 500 знаков, сделай более продающим, убери последний раздел…"></textarea>'
        + '<button class="btn edit-apply" data-path="'+esc(f.path)+'" style="min-width:0;flex:0 0 auto;">Внести правки</button>'
        + '<div class="status edit-status"></div>'
        + '</details></div>'
      ).join('');
    }catch(e){ list.innerHTML = '<p class="r-empty">Ошибка: '+esc(e.message)+'</p>'; }
  }

  const editsList = document.getElementById('edits-list');
  if(editsList){
    editsList.addEventListener('click', (e) => {
      const btn = e.target.closest('.edit-apply');
      if(btn) revise(btn);
    });
  }
  const loadBtn = document.getElementById('load-edits');
  if(loadBtn) loadBtn.addEventListener('click', loadEdits);
})();

// ---------- SEO-аудит: единый запуск по чекбоксам ----------
(() => {
  const checks = [...document.querySelectorAll('#audit-checks input[type=checkbox]')];
  const counter = document.getElementById('audit-counter');
  const selectAll = document.getElementById('audit-select-all');
  const runBtn = document.getElementById('run-audit');
  if(!runBtn) return;

  function updateCounter(){
    const enabled = checks.filter(c=>!c.disabled);
    const n = enabled.filter(c=>c.checked).length;
    if(counter) counter.textContent = 'Выбрано: ' + n + ' из ' + enabled.length;
    if(selectAll) selectAll.textContent = (enabled.length && enabled.every(c=>c.checked)) ? 'Снять все' : 'Выбрать все';
  }
  checks.forEach(c=>c.addEventListener('change', updateCounter));
  if(selectAll) selectAll.addEventListener('click', ()=>{
    const enabled = checks.filter(c=>!c.disabled);
    const makeChecked = !enabled.every(c=>c.checked);
    enabled.forEach(c=>{ c.checked = makeChecked; const l=c.closest('.check'); if(l) l.classList.toggle('checked', makeChecked); });
    updateCounter();
  });
  updateCounter();

  // ---- пресеты пунктов (общие для всех запусков) ----
  const presetSel = document.getElementById('audit-preset');
  let presetsLoaded = [];
  async function loadPresets(){
    try {
      const r = await (await fetch('/api/presets')).json();
      if(!r.ok) return;
      presetsLoaded = r.presets || [];
      if(presetSel) presetSel.innerHTML = '<option value="">Пресет пунктов…</option>' +
        presetsLoaded.map(p=>'<option value="'+esc(p.name)+'">'+esc(p.name)+'</option>').join('');
    } catch(e){}
  }
  const presetApply = document.getElementById('audit-preset-apply');
  if(presetApply) presetApply.addEventListener('click', ()=>{
    const p = presetsLoaded.find(x=>x.name===(presetSel && presetSel.value));
    if(!p){ alert('Выберите пресет'); return; }
    const wanted = new Set((p.points||[]).map(x=>String(x.point)));
    checks.forEach(c=>{ c.checked = wanted.has(c.dataset.point); const l=c.closest('.check'); if(l) l.classList.toggle('checked', c.checked); });
    updateCounter();
  });
  const presetSave = document.getElementById('audit-preset-save');
  if(presetSave) presetSave.addEventListener('click', async ()=>{
    const points = checks.filter(c=>c.checked).map(c=>({point:c.dataset.point, skill:c.dataset.skill}));
    if(!points.length){ alert('Отметьте хотя бы один пункт'); return; }
    const name = prompt('Название пресета');
    if(!name) return;
    const r = await (await fetch('/api/presets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name, points:points})})).json();
    if(!r.ok){ alert(r.error || 'Не удалось сохранить'); return; }
    await loadPresets();
    if(presetSel) presetSel.value = name;
  });
  loadPresets();

  // ---- семантическое ядро (необязательно, для 2.3) ----
  const dz = document.getElementById('dropzone-audit-core');
  const dzInput = document.getElementById('audit-core');
  const dzText = document.getElementById('audit-core-text');
  const dzChosen = document.getElementById('audit-core-chosen');
  const dzErr = document.getElementById('audit-core-err');
  let coreFile = null;
  function resetCore(){ coreFile = null; if(dzInput) dzInput.value=''; if(dzText) dzText.textContent='Перетащи файл семантического ядра или выбери его'; if(dzChosen) dzChosen.classList.remove('show'); if(dzErr) dzErr.classList.remove('show'); }
  function setCore(file){
    if(!file) return;
    const okExt = /\.(xlsx|xls|csv)$/i.test(file.name);
    const okSize = file.size <= 50*1024*1024;
    if(!okExt || !okSize){ if(dzErr) dzErr.classList.add('show'); resetCore(); return; }
    if(dzErr) dzErr.classList.remove('show');
    coreFile = file;
    if(dzText) dzText.textContent = 'Файл готов';
    if(dzChosen){ dzChosen.innerHTML = 'Выбран: <b>' + esc(file.name) + '</b> (' + (file.size/1024/1024).toFixed(2) + ' МБ) <span class="dz-clear">✕ убрать</span>'; dzChosen.classList.add('show'); }
    const clr = dzChosen && dzChosen.querySelector('.dz-clear');
    if(clr) clr.addEventListener('click', resetCore);
  }
  if(dz){
    ['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault(); dz.classList.add('over');}));
    ['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault(); dz.classList.remove('over');}));
    dz.addEventListener('drop', e=>{ const f=e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if(f) setCore(f); });
  }
  if(dzInput) dzInput.addEventListener('change', ()=>{ if(dzInput.files && dzInput.files[0]) setCore(dzInput.files[0]); });

  // слайдеры глубины проверки: отдельно для 2.1 (контент) и 4.1 (скорость)
  function setupDepth(elId, valId, def){
    const el = document.getElementById(elId);
    const val = document.getElementById(valId);
    if(!el || !val) return null;
    const fmt = (v)=>{ v = parseInt(v,10) || def; return v >= 1000 ? '1000+ (все страницы)' : (v + ' стр.'); };
    val.textContent = fmt(el.value);
    el.addEventListener('input', ()=>{ val.textContent = fmt(el.value); });
    return el;
  }
  const depthContentEl = setupDepth('audit-depth-content', 'audit-depth-content-val', 50);
  const depthSpeedEl = setupDepth('audit-depth-speed', 'audit-depth-speed-val', 10);

  runBtn.addEventListener('click', async () => {
    const url = document.getElementById('audit-url').value.trim();
    const points = checks.filter(c=>c.checked && !c.disabled).map(c=>({ point: c.dataset.point, skill: c.dataset.skill }));
    let depthContent = parseInt(depthContentEl ? depthContentEl.value : 50, 10);
    if(isNaN(depthContent) || depthContent < 1) depthContent = 50;
    let depthSpeed = parseInt(depthSpeedEl ? depthSpeedEl.value : 10, 10);
    if(isNaN(depthSpeed) || depthSpeed < 1) depthSpeed = 10;
    const contentAll = depthContent >= 1000;
    const speedAll = depthSpeed >= 1000;
    const depthContentToSend = contentAll ? 1000000 : depthContent;
    const depthSpeedToSend = speedAll ? 1000000 : depthSpeed;
    const dryRun = document.getElementById('audit-dry-run')?.checked === true;
    if(!url){ setStatus('status-audit','err','<b>Ошибка</b> Укажи URL сайта.'); return; }
    if(!points.length){ setStatus('status-audit','err','<b>Ошибка</b> Выбери хотя бы один пункт аудита.'); return; }
    if((contentAll || speedAll) && !confirm('Выбрано «все страницы» для ' + (contentAll && speedAll ? 'пунктов 2.1 и 4.1' : (contentAll ? 'пункта 2.1 «Текстовый контент»' : 'пункта 4.1 «Скорость загрузки»')) + ' — будут проверены ВСЕ страницы сайта. Это может занять очень много времени. Продолжить?')){ return; }
    disableBtn('run-audit', true);
    setStatus('status-audit','wait','<b>Отправка задания в opencode…</b>');
    try{
      let data;
      if(coreFile){
        const fd = new FormData();
        fd.append('url', url);
        fd.append('points', JSON.stringify(points));
        fd.append('depthContent', String(depthContentToSend));
        fd.append('depthSpeed', String(depthSpeedToSend));
        fd.append('dryRun', String(dryRun));
        fd.append('semcore', coreFile);
        const res = await fetch('/run-audit', { method:'POST', body: fd });
        const j = await res.json().catch(()=>({ok:false, error:'Не удалось прочитать ответ'}));
        if(!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
        data = j;
      }else{
        data = await post('/run-audit', { url, points, depthContent: depthContentToSend, depthSpeed: depthSpeedToSend, dryRun });
      }
      if(data.host){ selectProject(data.host); }
      if(data.queued){
        setStatus('status-audit','wait','<b>Аудит поставлен в очередь</b> — ваша позиция: ' + data.position +
          ', примерное ожидание: ' + data.eta + '. Сейчас выполняется аудитов: ' + data.running + ' из ' + data.max +
          '. Убрать задание можно в списке очереди ниже.' + (data.dryRun ? ' (режим только проверки)' : ''));
      }else{
        bindTask('status-audit', data.taskId, 'SEO-аудит — ' + url + (dryRun ? ' (только проверка)' : ''), data.host, 'a-results');
      }
      refreshAuditQueue();
    }catch(e){
      setStatus('status-audit','err','<b>Ошибка</b> ' + e.message);
    }finally{
      disableBtn('run-audit', false);
    }
  });

  // ---------- Панель очереди аудитов ----------
  const queueEl = document.getElementById('audit-queue');
  async function refreshAuditQueue(){
    if(!queueEl) return;
    try{
      const res = await fetch('/api/audit-queue');
      const d = await res.json().catch(()=>null);
      if(!d || !d.ok) return;
      if(!d.jobs || !d.jobs.length){ queueEl.innerHTML = ''; return; }
      queueEl.innerHTML = '<div style="font-size:12px;color:var(--muted)">Очередь аудитов (выполняется '+d.running+' из '+d.max+'):</div>'
        + d.jobs.map(j=>{
            const running = j.status === 'running';
            return '<div class="queue-item'+(running?' run':'')+'">'
              + '<div class="q-main"><div class="q-name">'+esc(j.site)+'</div>'
              + '<div class="q-meta">'+(running ? 'Выполняется…' : 'В очереди · позиция '+j.position+' · ожидание '+j.eta)+'</div></div>'
              + (running ? '' : '<button class="q-remove" data-job="'+escAttr(j.id)+'">Убрать из очереди</button>')
              + '</div>';
          }).join('');
      queueEl.querySelectorAll('.q-remove').forEach(b=>b.addEventListener('click', async ()=>{
        if(!confirm('Убрать этот аудит из очереди?')) return;
        b.disabled = true; b.textContent = 'Убираю…';
        try{
          const r = await fetch('/run-audit-cancel', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ jobId: b.dataset.job }) });
          const j = await r.json().catch(()=>({}));
          if(!r.ok || !j.ok) throw new Error(j.error||'ошибка');
        }catch(e){ alert('Не удалось убрать: '+e.message); }
        refreshAuditQueue();
      }));
    }catch(e){ /* ignore */ }
  }
  window.refreshAuditQueue = refreshAuditQueue;
  refreshAuditQueue();
  setInterval(refreshAuditQueue, 5000);
})();

// ---------- SMM: Анализ групп ----------
(() => {
  const groupsEl = document.getElementById('smm-groups');
  const fromEl = document.getElementById('smm-date-from');
  const toEl = document.getElementById('smm-date-to');
  const runBtn = document.getElementById('run-smm-groups');
  if(!groupsEl || !runBtn) return;

  // Значение по умолчанию — последние 30 дней.
  const today = new Date();
  const iso = (d)=> d.toISOString().slice(0,10);
  if(!toEl.value) toEl.value = iso(today);
  if(!fromEl.value){ const d = new Date(today); d.setDate(d.getDate() - 30); fromEl.value = iso(d); }

  runBtn.addEventListener('click', async () => {
    const groups = groupsEl.value.split(/\\r?\\n/).map(s=>s.trim()).filter(Boolean);
    const dateFrom = fromEl.value;
    const dateTo = toEl.value;
    const account = document.getElementById('smm-account').value.trim();

    if(!groups.length){ setStatus('status-smm-groups','err','<b>Ошибка</b> Добавь хотя бы одну группу.'); return; }
    if(!dateFrom || !dateTo){ setStatus('status-smm-groups','err','<b>Ошибка</b> Укажи период анализа (даты «с» и «по»).'); return; }
    if(dateFrom > dateTo){ setStatus('status-smm-groups','err','<b>Ошибка</b> Дата начала позже даты окончания.'); return; }

    disableBtn('run-smm-groups', true);
    setStatus('status-smm-groups','wait','<b>Отправка задания в opencode…</b>');
    try{
      const data = await post('/run-smm-groups', { groups, dateFrom, dateTo, account });
      if(data.host){ selectProject(data.host); }
      bindTask('status-smm-groups', data.taskId, 'Анализ групп — ' + groups.length + ' шт.', data.host, 'smm-results');
    }catch(e){
      setStatus('status-smm-groups','err','<b>Ошибка</b> ' + e.message);
    }finally{
      disableBtn('run-smm-groups', false);
    }
  });
})();

// ---------- SMM: Результаты ----------
(async () => {
  const smmSelect = document.getElementById('smm-project');
  const smmList = document.getElementById('smm-results-list');
  if(!smmSelect || !smmList) return;
  let smmProj = '';
  let smmCache = [];

  async function fillSmmSelect(){
    const projects = await fetchProjects('');
    smmCache = projects;
    const smmProjects = projects.filter(p => projectHasCats(p, SMM_CATS));
    if(smmProjects.length) revealResultsTab('smm-results');
    const cur = smmSelect.value;
    smmSelect.innerHTML = '<option value="">— выбери проект —</option>'
      + smmProjects.map(p=>'<option value="' + esc(p.host) + '">' + esc(p.host) + '</option>').join('');
    if(cur && smmProjects.some(p=>p.host===cur)) smmSelect.value = cur;
    smmProj = smmSelect.value || '';
    renderSmm();
  }

  function renderSmm(){
    if(!smmProj){ smmList.innerHTML = '<p class="r-empty">Выбери проект — покажу таблицы анализа групп.</p>'; return; }
    const proj = smmCache.find(p=>p.host===smmProj);
    if(!proj || proj.dates.length === 0){ smmList.innerHTML = '<p class="r-empty">По проекту «' + esc(smmProj) + '» пока нет таблиц.</p>'; return; }
    const icons = { '.csv':'📊', '.xlsx':'📗', '.xls':'📘' };
    const files = [];
    proj.dates.forEach(d=>d.files.forEach(f=>{
      if(SMM_CATS.includes(catOf(f))) files.push({ date: d.date, time: d.time, ...f });
    }));
    if(files.length === 0){ smmList.innerHTML = '<p class="r-empty">По проекту «' + esc(smmProj) + '» нет таблиц анализа групп.</p>'; return; }
    smmList.innerHTML = files.map((f)=>{
      const label = f.time ? (f.date + ' · ' + f.time.replace(/(\\d{2})(\\d{2})(\\d{2})/, '$1:$2:$3')) : f.date;
      const btn = f.ext === '.csv'
        ? '<button class="r-btn" onclick="previewFile(this)" data-file="' + esc(f.path) + '">Просмотр</button>'
        : '';
      return '<div class="r-item">'
        + '<div class="r-icon">' + (icons[f.ext] || '📄') + '</div>'
        + '<div class="r-info"><div class="r-name">' + esc(f.name) + '</div>'
        + '<div class="r-meta">' + esc(label) + ' · ' + esc(f.sizeHuman) + '</div></div>'
        + '<div class="r-actions">' + btn
        + '<a class="r-btn primary" href="' + dlHref(f.path) + '" download>Скачать</a>'
        + '<button class="r-btn danger" onclick="deleteSmmFile(this)" data-file="' + esc(f.path) + '">Удалить</button></div>'
        + '</div>';
    }).join('');
  }

  window.deleteSmmFile = async function(btn){
    const rel = btn.dataset.file;
    const name = rel.split('/').pop();
    if(!confirm('Удалить файл «' + name + '»?')) return;
    btn.disabled = true;
    btn.textContent = 'Удаляю…';
    try{
      const res = await fetch('/api/delete', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ file: rel })
      });
      const data = await res.json().catch(()=>({ok:false, error:'Не удалось прочитать ответ'}));
      if(!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      await fillSmmSelect();
    }catch(e){
      alert('Ошибка при удалении: ' + e.message);
      btn.disabled = false;
      btn.textContent = 'Удалить';
    }
  };

  // Кнопка «Удалить все файлы проекта» на вкладке результатов SMM.
  const deleteAllSmmBtn = document.getElementById('delete-all-smm');
  if(deleteAllSmmBtn) deleteAllSmmBtn.addEventListener('click', async ()=>{
    if(!smmProj){ alert('Сначала выбери проект.'); return; }
    if(!confirm('Удалить ВСЕ файлы проекта «' + smmProj + '»? Действие необратимо.')) return;
    const old = deleteAllSmmBtn.textContent;
    deleteAllSmmBtn.disabled = true;
    deleteAllSmmBtn.textContent = 'Удаляю…';
    try{
      const res = await fetch('/api/delete-all', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ host: smmProj })
      });
      const data = await res.json().catch(()=>({ok:false, error:'Не удалось прочитать ответ'}));
      if(!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      await fillSmmSelect();
    }catch(e){
      alert('Ошибка при удалении: ' + e.message);
    }finally{
      deleteAllSmmBtn.disabled = false;
      deleteAllSmmBtn.textContent = old;
    }
  });

  smmSelect.addEventListener('change', ()=>{ smmProj = smmSelect.value; renderSmm(); });
  document.getElementById('refresh-smm-results').addEventListener('click', async ()=>{ await fillSmmSelect(); });

  // При открытии вкладки «Результаты SMM» (в т.ч. кнопкой «Открыть результаты»)
  // подхватываем проект, выбранный в основной вкладке «Результаты».
  const smmTabBtn = document.querySelector('.tab[data-tab="smm-results"]');
  if(smmTabBtn) smmTabBtn.addEventListener('click', async ()=>{
    await fillSmmSelect();
    const mainHost = document.getElementById('project-select').value;
    if(mainHost && smmSelect.value !== mainHost){ smmSelect.value = mainHost; smmProj = mainHost; renderSmm(); }
  });

  await fillSmmSelect();
})();

// ---------- SEO-аудит: Результаты ----------
(async () => {
  const auditSelect = document.getElementById('audit-project');
  const auditList = document.getElementById('audit-results-list');
  let auditProj = '';
  let auditCache = [];

  async function fillSelect(){
    const projects = await fetchProjects('');
    auditCache = projects;
    const auditProjects = projects.filter(p => projectHasCats(p, AUDIT_CATS));
    if(auditProjects.length) revealResultsTab('a-results');
    const cur = auditSelect.value;
    auditSelect.innerHTML = '<option value="">— выбери проект —</option>'
      + auditProjects.map(p=>'<option value="' + esc(p.host) + '">' + esc(p.host) + '</option>').join('');
    if(cur && auditProjects.some(p=>p.host===cur)) auditSelect.value = cur;
    auditProj = auditSelect.value || '';
    renderAudit();
  }

  function renderAudit(){
    if(!auditProj){ auditList.innerHTML = '<p class="r-empty">Выбери проект (сайт) — покажу документы и таблицы по результатам аудита.</p>'; return; }
    const proj = auditCache.find(p=>p.host===auditProj);
    if(!proj || proj.dates.length === 0){ auditList.innerHTML = '<p class="r-empty">По проекту «' + esc(auditProj) + '» пока нет документов.</p>'; return; }
    const docs = [];
    proj.dates.forEach(d=>d.files.forEach(f=>{
      if(!AUDIT_CATS.includes(catOf(f))) return;
      const ext = (f.ext || '').toLowerCase();
      const name = (f.name || '');
      // Показываем только ИТОГОВЫЕ документы: единый docx аудита + таблицы (xlsx/csv).
      // Промежуточные docx по отдельным пунктам не показываем.
      const isFinalDocx = /\.docx?$/.test(ext) && /(seo[-_ ]?аудит|seo[-_ ]?audit)/i.test(name);
      const isTable = /\.(xlsx|xls|csv)$/.test(ext);
      if (isFinalDocx || isTable) docs.push({ date: d.date, time: d.time, ...f });
    }));
    if(docs.length === 0){ auditList.innerHTML = '<p class="r-empty">По проекту «' + esc(auditProj) + '» пока нет итоговых документов.</p>'; return; }
    auditList.innerHTML = docs.map((f)=>{
      const label = f.time ? (f.date + ' · ' + f.time.replace(/(\\d{2})(\\d{2})(\\d{2})/, '$1:$2:$3')) : f.date;
      return '<div class="r-item">'
        + '<div class="r-icon">📄</div>'
        + '<div class="r-info"><div class="r-name">' + esc(f.name) + '</div>'
        + '<div class="r-meta">' + esc(label) + ' · ' + esc(f.sizeHuman) + '</div></div>'
        + '<div class="r-actions"><a class="r-btn primary" href="' + dlHref(f.path) + '" download>Скачать</a>'
        + '<button class="r-btn danger" onclick="deleteAuditFile(this)" data-file="' + esc(f.path) + '">Удалить</button></div>'
        + '</div>';
    }).join('');
  }

  auditSelect.addEventListener('change', ()=>{ auditProj = auditSelect.value; renderAudit(); });
  document.getElementById('refresh-audit-results').addEventListener('click', async ()=>{ await fillSelect(); });

  async function loadAuditResults(){ await fillSelect(); }
  window.loadAuditResults = loadAuditResults;

  // Показ результатов аудита при нажатии «Открыть результаты»: выбрать проект и проскроллить к блоку.
  window.showAuditResults = async function(host){
    try { await fillSelect(); } catch(e){}
    if(host && [...auditSelect.options].some(o=>o.value===host)){
      auditSelect.value = host; auditProj = host; renderAudit();
    }
    const card = document.getElementById('audit-results-card');
    if(card){ setTimeout(()=>card.scrollIntoView({behavior:'smooth', block:'start'}), 100); }
  };

  window.deleteAuditFile = async function(btn){
    const rel = btn.dataset.file;
    const name = rel.split('/').pop();
    if(!confirm('Удалить документ «' + name + '»?')) return;
    btn.disabled = true;
    btn.textContent = 'Удаляю…';
    try{
      const res = await fetch('/api/delete', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ file: rel })
      });
      const data = await res.json().catch(()=>({ok:false, error:'Не удалось прочитать ответ'}));
      if(!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      await fillSelect();
    }catch(e){
      alert('Ошибка при удалении: ' + e.message);
      btn.disabled = false;
      btn.textContent = 'Удалить';
    }
  };

  // Кнопка «Удалить все файлы проекта» на вкладке результатов аудита.
  const deleteAllAuditBtn = document.getElementById('delete-all-audit');
  if(deleteAllAuditBtn) deleteAllAuditBtn.addEventListener('click', async ()=>{
    if(!auditProj){ alert('Сначала выбери проект (сайт).'); return; }
    if(!confirm('Удалить ВСЕ файлы проекта «' + auditProj + '»? Действие необратимо.')) return;
    const old = deleteAllAuditBtn.textContent;
    deleteAllAuditBtn.disabled = true;
    deleteAllAuditBtn.textContent = 'Удаляю…';
    try{
      const res = await fetch('/api/delete-all', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ host: auditProj })
      });
      const data = await res.json().catch(()=>({ok:false, error:'Не удалось прочитать ответ'}));
      if(!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      await fillSelect();
    }catch(e){
      alert('Ошибка при удалении: ' + e.message);
    }finally{
      deleteAllAuditBtn.disabled = false;
      deleteAllAuditBtn.textContent = old;
    }
  });

  await fillSelect();
})();

// ---------- Результаты ----------
const resultsList = document.getElementById('results-list');
const projectSelect = document.getElementById('project-select');
const overlay = document.getElementById('preview-overlay');
const previewTitle = document.getElementById('preview-title');
const previewBody = document.getElementById('preview-body');
const previewDownload = document.getElementById('preview-download');

function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtTime(ms){ try { return new Date(ms).toLocaleString('ru-RU'); } catch { return ''; } }
function dlHref(rel){ return '/api/download?file=' + encodeURIComponent(rel); }

let projectsCache = [];
let selectedHost = '';
let currentCat = 'all';

async function fetchProjects(host){
  const q = host ? ('?host=' + encodeURIComponent(host)) : '';
  const res = await fetch('/api/projects' + q);
  const data = await res.json().catch(()=>({ok:false}));
  return data.ok ? (data.projects || []) : [];
}

function catOf(f){ return f.category || 'other'; }
// Строгое разделение по вкладкам: каждая вкладка показывает только свои категории.
const SEO_TOOLS_CATS = ['extract', 'metatags', 'wordstat', 'topics', 'articles', 'microdata', 'other'];
const SMM_CATS = ['smm'];
const AUDIT_CATS = ['audit'];

// Проверяет, есть ли у проекта файлы заданных категорий.
function projectHasCats(project, cats){
  if(!project || !project.dates) return false;
  return project.dates.some(d => (d.files||[]).some(f => cats.includes(catOf(f))));
}

async function loadProjects(){
  const projects = await fetchProjects('');
  projectsCache = projects;
  const seoProjects = projects.filter(p => projectHasCats(p, SEO_TOOLS_CATS));
  if(seoProjects.length) revealResultsTab('results');
  const current = projectSelect.value;
  projectSelect.innerHTML = '<option value="">— выбери проект —</option>'
    + seoProjects.map(p=>'<option value="' + esc(p.host) + '">' + esc(p.host) + '</option>').join('');
  if(current && seoProjects.some(p=>p.host===current)) projectSelect.value = current;
  selectedHost = projectSelect.value || '';
  await renderResults();
}

async function renderResults(){
  const filters = document.getElementById('results-filters');
  if(!selectedHost){
    resultsList.innerHTML = '<p class="r-empty">Выбери проект (сайт) — покажу таблицы только по нему.</p>';
    if(filters) filters.style.display = 'none';
    return;
  }
  const [proj] = await fetchProjects(selectedHost);
  if(!proj || proj.dates.length === 0){
    resultsList.innerHTML = '<p class="r-empty">По проекту «' + esc(selectedHost) + '» пока нет таблиц.</p>';
    if(filters) filters.style.display = 'none';
    return;
  }
  const icons = { '.csv':'📊', '.xlsx':'📗', '.xls':'📘', '.docx':'📄', '.doc':'📄', '.md':'📋', '.html':'🌐' };
  renderDateFilter(proj.dates);
  const f = readDateFilter();
  const catFilter = (document.getElementById('flt-cat') || {}).value || '';
  const html = proj.dates.map(d => {
    if(!dateInFilter(d, f)) return '';
    // Показываем только результаты SEO-инструментов (белый список категорий).
    const files = d.files.filter(fc => {
      if(!SEO_TOOLS_CATS.includes(catOf(fc))) return false;
      if(catFilter && catOf(fc) !== catFilter) return false;
      return true;
    });
    if(!files.length) return '';
    const label = d.time ? (d.date + ' · ' + d.time.replace(/(\\d{2})(\\d{2})(\\d{2})/, '$1:$2:$3')) : d.date;
    const filesHtml = files.map(fc => {
      const icon = icons[fc.ext] || '📄';
      const btn = fc.ext === '.csv'
        ? '<button class="r-btn" onclick="previewFile(this)" data-file="' + esc(fc.path) + '">Просмотр</button>'
        : '';
      const cat = CATS[catOf(fc)] || 'Прочее';
      return '<div class="r-item">'
        + '<div class="r-icon">' + icon + '</div>'
        + '<div class="r-info"><div class="r-name">' + esc(fc.name) + '<span class="r-cat">' + esc(cat) + '</span></div>'
        + '<div class="r-meta">' + esc(fc.sizeHuman) + ' · ' + fmtTime(fc.mtime * 1000) + '</div></div>'
        + '<div class="r-actions">' + btn
        + '<a class="r-btn primary" href="' + dlHref(fc.path) + '" download>Cкачать</a>'
        + '<button class="r-btn danger" onclick="deleteResultFile(this)" data-file="' + esc(fc.path) + '">Удалить</button></div>'
        + '</div>';
    }).join('');
    return '<div class="proj-date">' + esc(d.folder) + '</div>' + filesHtml;
  }).join('');
  if(filters) filters.style.display = 'flex';
  resultsList.innerHTML = html || '<p class="r-empty">По проекту нет результатов SEO-инструментов.</p>';
}

// ---------- Фильтр по дате (год / месяц / диапазон) ----------
let dateFilterYears = [];

function readDateFilter(){
  return {
    year: (document.getElementById('flt-year') || {}).value || '',
    month: (document.getElementById('flt-month') || {}).value || '',
    from: (document.getElementById('flt-from') || {}).value || '',
    to: (document.getElementById('flt-to') || {}).value || ''
  };
}

function renderDateFilter(dates){
  const sel = document.getElementById('flt-year');
  if(!sel) return;
  const years = [...new Set(dates.map(d=>d.date.slice(0,4)).filter(Boolean))].sort().reverse();
  const sig = years.join(',');
  if(sig !== dateFilterYears.join(',')){
    dateFilterYears = years;
    const cur = sel.value;
    sel.innerHTML = '<option value="">Все годы</option>' + years.map(y=>'<option value="'+esc(y)+'">'+esc(y)+'</option>').join('');
    if(cur && years.includes(cur)) sel.value = cur;
  }
}

function dateInFilter(d, f){
  const dm = d.date ? d.date.slice(0,7) : ''; // YYYY-MM
  if(f.year && (!dm || dm.slice(0,4) !== f.year)) return false;
  if(f.month && (!dm || dm.slice(5,7) !== f.month)) return false;
  if(f.from && (!dm || dm < f.from)) return false;
  if(f.to && (!dm || dm > f.to)) return false;
  return true;
}

['flt-cat','flt-year','flt-month','flt-from','flt-to'].forEach(id=>{
  const el = document.getElementById(id);
  if(el) el.addEventListener('change', ()=>renderResults());
});
const fltReset = document.getElementById('flt-reset');
if(fltReset) fltReset.addEventListener('click', ()=>{
  ['flt-cat','flt-year','flt-month','flt-from','flt-to'].forEach(id=>{ const el = document.getElementById(id); if(el) el.value=''; });
  renderResults();
});

function setCat(c){
  currentCat = c;
  document.querySelectorAll('#cat-chips .chip').forEach(x=>x.classList.toggle('active', x.dataset.cat === c));
  renderResults();
}
document.querySelectorAll('#cat-chips .chip').forEach(c=>c.addEventListener('click', ()=>setCat(c.dataset.cat)));

function selectProject(host){
  projectSelect.value = host;
  selectedHost = host;
  currentCat = 'all';
  document.querySelectorAll('#cat-chips .chip').forEach(x=>x.classList.toggle('active', x.dataset.cat === 'all'));
  renderResults();
}

projectSelect.addEventListener('change', ()=>{
  selectedHost = projectSelect.value || '';
  currentCat = 'all';
  document.querySelectorAll('#cat-chips .chip').forEach(x=>x.classList.toggle('active', x.dataset.cat === 'all'));
  renderResults();
});
document.getElementById('refresh-results').addEventListener('click', loadProjects);

window.previewFile = async function(btn){
  const rel = btn.dataset.file;
  overlay.classList.add('show');
  previewTitle.textContent = rel.split('/').pop();
  previewBody.innerHTML = '<p style="color:var(--muted)">Загрузка предпросмотра…</p>';
  previewDownload.setAttribute('href', dlHref(rel));
  try{
    const res = await fetch('/api/preview?file=' + encodeURIComponent(rel));
    const data = await res.json();
    if(!data.ok){ previewBody.innerHTML = '<p style="color:var(--danger)">' + esc(data.error||'Ошибка') + '</p>'; return; }
    if(!data.csv){
      previewBody.innerHTML = '<p style="color:var(--muted)">' + esc(data.note||'') + '</p>';
      return;
    }
    if(!data.rows || data.rows.length === 0){ previewBody.innerHTML = '<p style="color:var(--muted)">Таблица пуста.</p>'; return; }
    const cols = Math.max(...data.rows.map(r=>r.length));
    previewBody.innerHTML = '<table class="preview"><thead><tr>' + Array.from({length:cols},(_,i)=>'<th>'+esc(data.rows[0][i]??'')+'</th>').join('') + '</tr></thead><tbody>'
      + data.rows.slice(1).map(r=>'<tr>'+Array.from({length:cols},(_,i)=>'<td>'+esc(r[i]??'')+'</td>').join('')+'</tr>').join('')
      + '</tbody></table>'
      + '<p style="color:var(--muted);font-size:12px;margin-top:8px">Показаны первые ' + data.rows.length + ' строк. Полная таблица — кнопкой «Скачать».</p>';
  }catch(e){
    previewBody.innerHTML = '<p style="color:var(--danger)">' + esc(e.message) + '</p>';
  }
};

document.getElementById('preview-close').addEventListener('click', ()=>{ overlay.classList.remove('show'); });
overlay.addEventListener('click', e=>{ if(e.target === overlay) overlay.classList.remove('show'); });

window.deleteResultFile = async function(btn){
  const rel = btn.dataset.file;
  const name = rel.split('/').pop();
  if(!confirm('Удалить файл «' + name + '»?')) return;
  btn.disabled = true;
  btn.textContent = 'Удаляю…';
  try{
    const res = await fetch('/api/delete', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ file: rel })
    });
    const data = await res.json().catch(()=>({ok:false, error:'Не удалось прочитать ответ'}));
    if(!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    await loadProjects();
  }catch(e){
    alert('Ошибка при удалении: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Удалить';
  }
};

loadProjects();
setInterval(loadProjects, 5000);

// Кнопка «Удалить все файлы проекта» на вкладке результатов.
const deleteAllBtn = document.getElementById('delete-all-results');
if(deleteAllBtn) deleteAllBtn.addEventListener('click', async ()=>{
  if(!selectedHost){ alert('Сначала выбери проект (сайт).'); return; }
  if(!confirm('Удалить ВСЕ файлы проекта «' + selectedHost + '»? Действие необратимо.')) return;
  const old = deleteAllBtn.textContent;
  deleteAllBtn.disabled = true;
  deleteAllBtn.textContent = 'Удаляю…';
  try{
    const res = await fetch('/api/delete-all', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ host: selectedHost })
    });
    const data = await res.json().catch(()=>({ok:false, error:'Не удалось прочитать ответ'}));
    if(!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    await loadProjects();
  }catch(e){
    alert('Ошибка при удалении: ' + e.message);
  }finally{
    deleteAllBtn.disabled = false;
    deleteAllBtn.textContent = old;
  }
});

// ---------- Geo/AEO tracker: статус в футере ----------
(async () => {
  const el = document.getElementById('tracker-status');
  if(!el) return;
  const STATE_LABEL = {
    off: 'остановлен', starting: 'запускается…', build: 'сборка…',
    ready: 'запущен', error: 'ошибка'
  };
  async function loadTracker(){
    try{
      const res = await fetch('/api/tracker');
      const j = await res.json();
      if(!j || !j.ok) return;
      const color = j.state === 'ready' ? 'var(--green)' : (j.state === 'error' ? 'var(--danger)' : 'var(--muted)');
      el.innerHTML = 'Geo/AEO tracker: <b style="color:'+color+'">' + esc(STATE_LABEL[j.state] || j.state) + '</b>'
        + (j.state === 'ready' ? ' · <a href="'+esc(j.url)+'" target="_blank" rel="noopener" style="color:var(--accent)">'+esc(j.url)+'</a>' : '')
        + (j.message ? ' <span style="color:var(--muted)">— '+esc(j.message)+'</span>' : '')
        + (j.restartable === false ? '' : ' <button class="r-btn" id="tracker-restart" style="margin-left:6px;padding:3px 10px;font-size:11px;">Перезапустить</button>');
      const btn = document.getElementById('tracker-restart');
      if(btn) btn.addEventListener('click', async ()=>{
        btn.disabled = true; btn.textContent = '…';
        try{
          const r = await fetch('/api/tracker/restart', { method:'POST' });
          const d = await r.json().catch(()=>({}));
          if(!r.ok || d.ok === false) alert(d.error || 'Не удалось перезапустить трекер');
        }catch(e){}
        setTimeout(loadTracker, 3000);
      });
    }catch(e){}
  }
  loadTracker();
  setInterval(loadTracker, 4000);
})();
</script>
 </body>
</html>`
}

function buildAdminHtml(port: number, lanIp: string | null, auth?: AuthInfo | null): string {
  const isIt = !!auth && auth.role === "it"
  const isTest = (process.env.SEO_CENTER_ENV || "").trim().toLowerCase() === "test"
  const roleLabel = !auth ? "" : (auth.role === "it" ? "IT-администратор" : (auth.role === "admin" ? "администратор" : auth.uid))
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SEO-центр — админ-панель</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%234f8cff'/%3E%3Cstop offset='1' stop-color='%237c5cff'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='32' height='32' rx='7' fill='url(%23g)'/%3E%3Ccircle cx='12' cy='13' r='5.5' fill='none' stroke='white' stroke-width='2.4'/%3E%3Cpath d='M16.5 17.5 L21 22' stroke='white' stroke-width='2.8' stroke-linecap='round'/%3E%3C/svg%3E">
<style>
  :root {
    --bg: #0f1117; --panel: #171a23; --panel-2: #1e2230; --border: #2a2f3f;
    --text: #e6e9f0; --muted: #9aa3b2; --accent: #4f8cff; --accent-2: #7c5cff;
    --green: #35c48b; --danger: #ff5c6c; --radius: 12px; color-scheme: dark;
  }
  html[data-theme="light"] {
    --bg: #f4f6fb; --panel: #ffffff; --panel-2: #edf0f7; --border: #d7dce8;
    --text: #1b1f2a; --muted: #5c6678; --accent: #3b74e0; --accent-2: #6d4ce0;
    --green: #1f9e6a; --danger: #d93648; color-scheme: light;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    background: var(--bg); color: var(--text); min-height: 100vh; padding: 32px 20px;
    transition: background-color .2s, color .2s; }
  .wrap { max-width: 1180px; margin: 0 auto; }
  header.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 22px; }
  .brand h1 { font-size: 24px; font-weight: 700; background: linear-gradient(90deg, var(--accent), var(--accent-2)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
  .brand p { color: var(--muted); font-size: 13px; margin-top: 4px; }
  .top-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .linkbtn, .theme-toggle { display: inline-flex; align-items: center; gap: 8px; padding: 9px 15px; border: 1px solid var(--border);
    border-radius: 22px; background: var(--panel-2); color: var(--text); font-size: 13px; font-weight: 600; cursor: pointer;
    text-decoration: none; font-family: inherit; white-space: nowrap; transition: border-color .15s, color .15s; }
  .linkbtn:hover, .theme-toggle:hover { border-color: var(--accent); color: var(--accent); }
  .tt-track { position: relative; width: 38px; height: 21px; border-radius: 20px; flex-shrink: 0; background: linear-gradient(90deg, var(--accent), var(--accent-2)); }
  .tt-knob { position: absolute; top: 2px; left: 2px; width: 17px; height: 17px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.4); transition: transform .2s; }
  html[data-theme="light"] .tt-knob { transform: translateX(17px); }
  .tabs { display: flex; gap: 6px; background: var(--panel-2); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px; margin-bottom: 20px; flex-wrap: wrap; }
  .tab { padding: 10px 18px; border: none; border-radius: 9px; background: transparent; color: var(--muted); font-size: 14px; font-weight: 600; cursor: pointer; transition: color .15s, background .15s; }
  .tab:hover { color: var(--text); }
  .tab.active { background: var(--panel); color: var(--text); box-shadow: inset 0 0 0 1px var(--border); }
  .apanel { display: none; } .apanel.show { display: block; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-bottom: 16px; }
  .card h2 { font-size: 16px; font-weight: 600; margin-bottom: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
  .stat { background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .stat .k { color: var(--muted); font-size: 12px; }
  .stat .v { font-size: 21px; font-weight: 700; margin-top: 5px; word-break: break-word; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid var(--border); padding: 7px 9px; text-align: left; vertical-align: middle; }
  th { background: var(--panel-2); font-weight: 600; }
  .scroll { overflow-x: auto; }
  input, select, textarea { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; color: var(--text);
    padding: 9px 11px; font-size: 14px; font-family: inherit; outline: none; }
  input:focus, select:focus, textarea:focus { border-color: var(--accent); }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field label { font-size: 12px; color: var(--muted); font-weight: 600; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 9px 16px; border: 1px solid var(--border);
    border-radius: 9px; background: var(--panel-2); color: var(--text); font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; }
  .btn:hover { border-color: var(--accent); }
  .btn.primary { background: linear-gradient(90deg, var(--accent), var(--accent-2)); border: none; color: #fff; }
  .btn.primary:hover { filter: brightness(1.08); }
  .btn.danger { color: var(--danger); }
  .btn.danger:hover { border-color: var(--danger); background: rgba(255,92,108,.08); }
  .btn.small { padding: 5px 10px; font-size: 12px; }
  .muted { color: var(--muted); font-size: 13px; }
  code { background: var(--panel-2); border: 1px solid var(--border); padding: 2px 7px; border-radius: 6px; font-size: 12px; font-family: ui-monospace, Menlo, Consolas, monospace; }
  .tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 20px; background: rgba(79,140,255,.14); color: var(--accent); }
  .tag.green { background: rgba(53,196,139,.15); color: var(--green); }
  .tag.red { background: rgba(255,92,108,.15); color: var(--danger); }
  .tag.gray { background: var(--panel-2); color: var(--muted); }
  .env-badge { display: inline-block; vertical-align: middle; font-size: 11px; font-weight: 800; letter-spacing: .5px; padding: 3px 9px; border-radius: 20px; background: rgba(255,196,0,.15); color: #ffd166; border: 1px solid rgba(255,196,0,.45); }
  .log { white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 12px; max-height: 440px; overflow: auto; }
  .toast { position: fixed; right: 20px; bottom: 20px; background: var(--panel); border: 1px solid var(--border); border-left: 3px solid var(--accent);
    border-radius: 9px; padding: 12px 16px; font-size: 13px; box-shadow: 0 6px 24px rgba(0,0,0,.35); max-width: 380px; opacity: 0; transform: translateY(10px);
    transition: opacity .2s, transform .2s; pointer-events: none; z-index: 50; }
  .toast.show { opacity: 1; transform: none; }
  .toast.err { border-left-color: var(--danger); }
  .toast.ok { border-left-color: var(--green); }
  .banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    background: rgba(255,196,0,.15); border: 1px solid rgba(196,138,0,.5); color: #7a5c00;
    border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; font-size: 13px; }
  html[data-theme="dark"] .banner { color: #ffd166; border-color: rgba(255,196,0,.45); background: rgba(255,196,0,.12); }
  .restarting { position: fixed; inset: 0; background: rgba(5,7,12,.78); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .restarting .rbox { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 26px 32px; text-align: center; }
  .restarting .rtext { margin-top: 14px; font-size: 14px; color: var(--text); }
  .spin { width: 34px; height: 34px; margin: 0 auto; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: sp .8s linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }
  .hint { color: var(--muted); font-size: 12px; margin-top: 6px; line-height: 1.5; }
</style>
<script>
(function(){try{var t=localStorage.getItem('seo-theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();
</script>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="brand">
      <h1>Админ-панель SEO-центра${isTest ? ' <span class="env-badge">ТЕСТ</span>' : ''}</h1>
      <p>Пользователи, задачи и проекты${isIt ? ", логи и бэкапы" : ""}${roleLabel ? " · " + roleLabel : ""}</p>
    </div>
    <div class="top-actions">
      <a class="linkbtn" href="/">← В панель</a>
      ${isIt ? '<button class="linkbtn" id="restart-btn" type="button" title="' + (isTest ? "Перезапустить тестовый сервис" : "Применить правки на боевой сервис") + '">⟳ ' + (isTest ? "Перезагрузить" : "Залить правки") + '</button>' : ''}
      <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Переключить тему">
        <span class="tt-track"><span class="tt-knob"></span></span>
        <span class="tt-label">Тёмная тема</span>
      </button>
      <a class="linkbtn" href="/logout">Выйти</a>
    </div>
  </header>

  ${isIt ? '<div class="banner" id="restart-banner" style="display:none"></div>' : ''}

  <div class="tabs" id="admin-tabs">
    <button class="tab active" data-atab="overview">Обзор</button>
    <button class="tab" data-atab="users">Пользователи</button>
    <button class="tab" data-atab="jobs">Задачи и очередь</button>
    <button class="tab" data-atab="projects">Проекты и результаты</button>
    ${isIt ? '<button class="tab" data-atab="logs">Логи</button>' : ''}
    ${isIt ? '<button class="tab" data-atab="backups">Бэкапы</button>' : ''}
  </div>

  <section class="apanel show" id="ap-overview">
    <div class="card">
      <h2>Сводка</h2>
      <div class="grid" id="ov-stats"><span class="muted">Загрузка…</span></div>
    </div>
    <div class="card">
      <h2>Настройки сервиса</h2>
      <div class="row">
        <div class="field" style="min-width:200px"><label>Одновременных аудитов</label><input type="number" id="set-concurrent" min="1" max="20"></div>
        <div class="field" style="min-width:200px"><label>Средняя длительность, мин</label><input type="number" id="set-avg" min="1" max="600"></div>
        <div class="field" style="min-width:200px"><label>Хранить результаты, дней (0 — вечно)</label><input type="number" id="set-retention" min="0" max="3650"></div>
        <button class="btn primary" id="save-settings">Сохранить</button>
        <button class="btn" id="retention-now" title="Удалить результаты старше срока хранения">Прибрать старые сейчас</button>
      </div>
      <div class="hint">Лимит одновременных аудитов применяется к очереди сразу, без перезапуска сервиса. Срок хранения (0 — вечно) чистка выполняет раз в 6 часов и по кнопке.</div>
    </div>
  </section>

  <section class="apanel" id="ap-users">
    <div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:14px">
        <h2 style="margin:0">Пользователи</h2>
        <button class="btn primary" id="new-user">+ Добавить пользователя</button>
      </div>
      <div class="scroll"><table id="users-table"><thead><tr><th>Логин</th><th>Пароль</th><th>Роль</th><th>Активен</th><th>Последний вход</th><th>IP</th><th>Входов</th><th></th></tr></thead><tbody></tbody></table></div>
    </div>
    <div class="card" id="user-form-card" style="display:none">
      <h2 id="user-form-title">Добавить пользователя</h2>
      <div class="row">
        <div class="field" style="min-width:180px"><label>Имя входа</label><input type="text" id="u-name" autocomplete="off"></div>
        <div class="field" style="min-width:160px"><label>Роль</label><select id="u-role"><option value="user">Сотрудник</option><option value="admin">Администратор</option></select></div>
        <div class="field" style="min-width:180px"><label>Пароль</label><input type="text" id="u-pass" autocomplete="off"></div>
        <button class="btn" id="gen-pass" title="Сгенерировать пароль из 8 символов">Сгенерировать</button>
        <div class="field"><label>Активен</label><select id="u-active"><option value="1">Да</option><option value="0">Нет</option></select></div>
        <button class="btn primary" id="save-user">Сохранить</button>
        <button class="btn" id="reset-user">Отмена</button>
      </div>
      <div class="hint">Именованные пользователи входят по своему имени и паролю. Роль «Администратор» видит все проекты и админку.</div>
    </div>
  </section>

  <section class="apanel" id="ap-jobs">
    <div class="card">
      <h2>Активные задачи</h2>
      <div class="scroll"><table id="jobs-running"><thead><tr><th>Инструмент</th><th>Задача</th><th>Владелец</th><th>Начато</th><th></th></tr></thead><tbody></tbody></table></div>
    </div>
    <div class="card">
      <h2>Очередь аудитов</h2>
      <div class="scroll"><table id="jobs-queued"><thead><tr><th>#</th><th>Сайт</th><th>Владелец</th><th>Ожидание</th><th></th></tr></thead><tbody></tbody></table></div>
    </div>
    <div class="card">
      <h2>История запусков</h2>
      <div class="scroll"><table id="jobs-history"><thead><tr><th>Когда</th><th>Пользователь</th><th>Инструмент</th><th>Сайт</th><th>Статус</th></tr></thead><tbody></tbody></table></div>
    </div>
  </section>

  <section class="apanel" id="ap-projects">
    <div class="card">
      <h2>Все проекты и файлы</h2>
      <div class="row" style="margin-bottom:14px">
        <button class="btn" id="refresh-projects">Обновить</button>
        <div class="field" style="min-width:180px"><label>Удалить запуски старше, дней</label><input type="number" id="cleanup-days" min="1" value="90"></div>
        <button class="btn danger" id="cleanup-old">Очистить старые</button>
      </div>
      <div class="scroll"><table id="projects-table"><thead><tr><th>Проект (сайт)</th><th>Запусков</th><th>Файлов</th><th>Размер</th><th>Владельцы</th><th>Последний запуск</th><th></th></tr></thead><tbody></tbody></table></div>
      <div class="hint">Нажми на проект — покажу файлы, каждый можно скачать.</div>
    </div>
  </section>

  ${isIt ? `<section class="apanel" id="ap-logs">
    <div class="card">
      <h2>Журнал аудита и ошибки</h2>
      <div class="row" style="margin-bottom:12px">
        <div class="field" style="min-width:200px"><label>Источник</label><select id="log-type"><option value="audit">Журнал аудита</option><option value="service">Сервис (stdout)</option></select></div>
        <div class="field" style="min-width:140px"><label>Строк</label><input type="number" id="log-lines" min="20" max="2000" value="300"></div>
        <button class="btn" id="refresh-logs">Обновить</button>
        <button class="btn" id="download-logs">Скачать</button>
        <button class="btn danger" id="clear-logs">Очистить журнал</button>
      </div>
      <div class="log" id="log-view">Загрузка…</div>
    </div>
  </section>

  <section class="apanel" id="ap-backups">
    <div class="card">
      <h2>Архивы</h2>
      <div class="row" style="margin-bottom:14px">
        <button class="btn primary" id="run-backup">Создать архив</button>
        <button class="btn" id="refresh-backups">Обновить</button>
        <span class="muted" id="backup-status"></span>
      </div>
      <div class="scroll"><table id="backups-table"><thead><tr><th>Файл</th><th>Размер</th><th>Дата</th><th></th></tr></thead><tbody></tbody></table></div>
    </div>
    <div class="card">
      <h2>Место на диске</h2>
      <div id="disk-box" class="muted">Загрузка…</div>
    </div>
  </section>` : ""}
</div>

<div class="toast" id="toast"></div>
${isIt ? '<div class="restarting" id="restart-overlay" style="display:none"><div class="rbox"><div class="spin"></div><div class="rtext" id="restart-text">Перезагружаю сервис…</div></div></div>' : ''}

<script>
var API = '/api/admin';
var IS_TEST_ENV = ${isTest ? "true" : "false"};
var RESTART_LABEL = IS_TEST_ENV ? 'Перезагрузить' : 'Залить правки';
function el(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
function fmtSize(n){ n=Number(n)||0; if(n<1024)return n+' Б'; if(n<1048576)return (n/1024).toFixed(1)+' КБ'; if(n<1073741824)return (n/1048576).toFixed(1)+' МБ'; return (n/1073741824).toFixed(2)+' ГБ'; }
function fmtDate(v){ if(v==null||v==='')return '—'; try{ var d=(typeof v==='number')?new Date(v):new Date(v); return d.toLocaleString('ru-RU'); }catch(e){ return String(v); } }
var _toastT=null;
function toast(msg, kind){ var t=el('toast'); t.textContent=msg; t.className='toast show '+(kind||''); clearTimeout(_toastT); _toastT=setTimeout(function(){ t.className='toast'; }, 4200); }
async function api(path, opts){
  opts = opts || {};
  if(opts.body && typeof opts.body !== 'string'){ opts.headers=Object.assign({'Content-Type':'application/json'}, opts.headers||{}); opts.body=JSON.stringify(opts.body); }
  var r = await fetch(API+path, opts);
  var j = null; try{ j = await r.json(); }catch(e){}
  if(!r.ok || (j && j.ok===false)) throw new Error((j && j.error) || ('HTTP '+r.status));
  return j;
}
// Тема
var tb = el('theme-toggle');
function applyTheme(t){ t = t==='light'?'light':'dark'; document.documentElement.setAttribute('data-theme',t); if(tb){ var l=tb.querySelector('.tt-label'); if(l) l.textContent = t==='light'?'Светлая тема':'Тёмная тема'; } try{ localStorage.setItem('seo-theme',t); }catch(e){} }
applyTheme(document.documentElement.getAttribute('data-theme'));
if(tb) tb.addEventListener('click', function(){ applyTheme(document.documentElement.getAttribute('data-theme')==='light'?'dark':'light'); });
// Табы
var LOADERS = {};
function switchTab(name){
  document.querySelectorAll('#admin-tabs .tab').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-atab')===name); });
  document.querySelectorAll('.apanel').forEach(function(p){ p.classList.toggle('show', p.id==='ap-'+name); });
  if(LOADERS[name]) LOADERS[name]();
}
document.querySelectorAll('#admin-tabs .tab').forEach(function(b){ b.addEventListener('click', function(){ switchTab(b.getAttribute('data-atab')); }); });

function statCard(k, v){ return '<div class="stat"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div></div>'; }

// ---------- Обзор ----------
async function loadOverview(){
  try{
    var d = await api('/overview');
    var s = d.stats || {};
    el('ov-stats').innerHTML =
      statCard('Пользователей', s.users||0) +
      statCard('Активных задач', s.runningTasks||0) +
      statCard('В очереди аудитов', s.queuedAudits||0) +
      statCard('Результаты', s.resultsSizeHuman||'0') +
      statCard('Архивы', s.archivesSizeHuman||'0') +
      statCard('Аптайм', s.uptimeHuman||'—') +
      statCard('Порт', s.port||'') +
      statCard('Основная модель', s.modelMain||'');
    if(s.settings){ el('set-concurrent').value=s.settings.auditMaxConcurrent; el('set-avg').value=s.settings.auditAvgMinutes; el('set-retention').value=s.settings.resultsRetentionDays; }
  }catch(e){ toast('Обзор: '+e.message,'err'); }
}
LOADERS.overview = loadOverview;

el('save-settings').addEventListener('click', async function(){
  try{
    await api('/settings', { method:'POST', body:{ auditMaxConcurrent:Number(el('set-concurrent').value), auditAvgMinutes:Number(el('set-avg').value), resultsRetentionDays:Number(el('set-retention').value) } });
    toast('Настройки сохранены','ok'); loadOverview();
  }catch(e){ toast('Ошибка: '+e.message,'err'); }
});
if(el('retention-now')) el('retention-now').addEventListener('click', async function(){
  var days = Number(el('set-retention').value)||0;
  if(days<=0){ toast('Срок хранения = 0 (вечно). Задай число дней и сохрани настройки.','err'); return; }
  if(!confirm('Удалить результаты старше '+days+' дней во всех проектах?'))return;
  try{ var r = await api('/retention-run',{method:'POST',body:{}}); toast('Удалено запусков: '+(r.dirs||0)+', файлов: '+(r.removed||0),'ok'); }
  catch(e){ toast('Ошибка: '+e.message,'err'); }
});

// ---------- Пользователи ----------
var editUserOrig = '';
function fillUserForm(u){
  editUserOrig = u ? u.name : '';
  el('user-form-card').style.display = '';
  el('u-name').value = u ? u.name : '';
  el('u-role').value = u ? u.role : 'user';
  el('u-pass').value = u ? (u.password||'') : '';
  el('u-active').value = u && u.active ? '1' : (u ? '0' : '1');
  el('user-form-title').textContent = u ? ('Изменить: '+u.name) : 'Добавить пользователя';
  el('u-name').focus();
}
async function loadUsers(){
  try{
    var d = await api('/users');
    var rows = (d.users||[]).map(function(u){
      return '<tr>'+
        '<td>'+esc(u.name)+'</td>'+
        '<td><code>'+esc(u.password||'')+'</code></td>'+
        '<td>'+(u.role==='admin'?'<span class="tag">Админ</span>':(u.role==='it'?'<span class="tag">IT</span>':'<span class="tag gray">Сотрудник</span>'))+'</td>'+
        '<td>'+(u.active?'<span class="tag green">Да</span>':'<span class="tag red">Нет</span>')+'</td>'+
        '<td>'+esc(fmtDate(u.lastLoginAt))+'</td>'+
        '<td>'+esc(u.lastLoginIp||'—')+'</td>'+
        '<td>'+esc(u.logins||0)+'</td>'+
        '<td><button class="btn small" onclick="window.__editUser(this.dataset.name)" data-name="'+esc(u.name)+'">Изм.</button> '+
        '<button class="btn small danger" onclick="window.__delUser(this.dataset.name)" data-name="'+esc(u.name)+'">Удалить</button></td>'+
      '</tr>';
    }).join('');
    el('users-table').querySelector('tbody').innerHTML = rows || '<tr><td colspan="8" class="muted">Нет пользователей</td></tr>';
    window.__usersCache = d.users||[];
  }catch(e){ toast('Пользователи: '+e.message,'err'); }
}
LOADERS.users = loadUsers;
window.__editUser = function(name){ var u=(window.__usersCache||[]).find(function(x){return x.name===name;}); if(u){ fillUserForm(u); document.querySelector('#ap-users').scrollIntoView({behavior:'smooth', block:'start'}); } };
window.__delUser = async function(name){
  if(!confirm('Удалить пользователя «'+name+'»?')) return;
  try{ await api('/users/delete',{method:'POST',body:{name:name}}); toast('Пользователь удалён','ok'); loadUsers(); }
  catch(e){ toast('Ошибка: '+e.message,'err'); }
};
el('save-user').addEventListener('click', async function(){
  var name = el('u-name').value.trim();
  if(!name){ toast('Укажи имя','err'); return; }
  try{
    await api('/users/save',{method:'POST',body:{ name:name, role:el('u-role').value, password:el('u-pass').value, active:el('u-active').value==='1', originalName:editUserOrig }});
    toast('Сохранено','ok'); editUserOrig=''; el('user-form-card').style.display='none'; loadUsers();
  }catch(e){ toast('Ошибка: '+e.message,'err'); }
});
el('reset-user').addEventListener('click', function(){ editUserOrig=''; el('user-form-card').style.display='none'; });
el('new-user').addEventListener('click', function(){ fillUserForm(null); document.querySelector('#ap-users').scrollIntoView({behavior:'smooth', block:'start'}); });
el('gen-pass').addEventListener('click', function(){
  var chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var bytes = new Uint8Array(12); crypto.getRandomValues(bytes);
  var s = ''; for(var i=0;i<8;i++){ s += chars.charAt(bytes[i] % chars.length); }
  el('u-pass').value = s;
  el('u-pass').focus(); el('u-pass').select();
  toast('Пароль сгенерирован — сохрани его и передай коллеге','ok');
});

// ---------- Задачи ----------
async function loadJobs(){
  try{
    var d = await api('/jobs');
    el('jobs-running').querySelector('tbody').innerHTML = (d.running||[]).map(function(t){
      return '<tr><td>'+esc(t.tool)+'</td><td>'+esc(t.label)+'</td><td>'+esc(t.owner||'—')+'</td><td>'+esc(fmtDate(t.startedAt))+'</td>'+
        '<td><button class="btn small danger" onclick="window.__cancelTask(this.dataset.id)" data-id="'+esc(t.id)+'">Отменить</button></td></tr>';
    }).join('') || '<tr><td colspan="5" class="muted">Нет активных задач</td></tr>';
    el('jobs-queued').querySelector('tbody').innerHTML = (d.queued||[]).map(function(j,i){
      return '<tr><td>'+(i+1)+'</td><td>'+esc(j.site)+'</td><td>'+esc(j.owner||'—')+'</td><td>'+esc(j.eta||'')+'</td>'+
        '<td><button class="btn small danger" onclick="window.__cancelJob(this.dataset.id)" data-id="'+esc(j.id)+'">Убрать</button></td></tr>';
    }).join('') || '<tr><td colspan="5" class="muted">Очередь пуста</td></tr>';
    var stMap = { running:'<span class="tag">выполняется</span>', done:'<span class="tag green">готово</span>', error:'<span class="tag red">ошибка</span>', cancelled:'<span class="tag gray">отменено</span>', queued:'<span class="tag gray">в очереди</span>' };
    el('jobs-history').querySelector('tbody').innerHTML = (d.history||[]).map(function(h){
      return '<tr><td>'+esc(fmtDate(h.at))+'</td><td>'+esc(h.user||'—')+'</td><td>'+esc(h.tool)+'</td><td>'+esc(h.site||'—')+'</td><td>'+(stMap[h.status]||esc(h.status))+'</td></tr>';
    }).join('') || '<tr><td colspan="5" class="muted">История пуста</td></tr>';
  }catch(e){ toast('Задачи: '+e.message,'err'); }
}
LOADERS.jobs = loadJobs;
window.__cancelTask = async function(id){ if(!confirm('Отменить задачу?'))return; try{ await api('/jobs/cancel',{method:'POST',body:{taskId:id}}); toast('Задача отменена','ok'); loadJobs(); }catch(e){ toast('Ошибка: '+e.message,'err'); } };
window.__cancelJob = async function(id){ if(!confirm('Убрать из очереди?'))return; try{ await api('/jobs/cancel',{method:'POST',body:{jobId:id}}); toast('Убрано из очереди','ok'); loadJobs(); }catch(e){ toast('Ошибка: '+e.message,'err'); } };

// ---------- Проекты ----------
async function loadProjects(){
  try{
    var d = await api('/projects');
    window.__projectsCache = d.projects||[];
    var rows = (d.projects||[]).map(function(p, i){
      var files = (p.fileList||[]).map(function(f){
        return '<tr><td>'+esc(f.name)+'</td><td>'+esc(((f.date||'')+' '+(f.time||'')).trim())+'</td><td>'+esc(f.owner||'—')+'</td><td>'+esc(f.sizeHuman||fmtSize(f.size))+'</td>'+
          '<td><a class="btn small" href="/api/download?file='+encodeURIComponent(f.path)+'">Скачать</a></td></tr>';
      }).join('') || '<tr><td colspan="5" class="muted">Файлов нет</td></tr>';
      var detail = '<tr id="pdetail-'+i+'" style="display:none"><td colspan="7">'+
        '<table style="width:100%;margin:4px 0"><thead><tr><th>Файл</th><th>Запуск</th><th>Владелец</th><th>Размер</th><th></th></tr></thead><tbody>'+files+'</tbody></table></td></tr>';
      return '<tr>'+
        '<td><button class="btn small" onclick="window.__toggleProject('+i+')">'+esc(p.host)+' ▾</button></td>'+
        '<td>'+esc(p.runs)+'</td><td>'+esc(p.files)+'</td><td>'+esc(fmtSize(p.size))+'</td>'+
        '<td>'+esc((p.owners||[]).join(', ')||'—')+'</td><td>'+esc(fmtDate(p.last))+'</td>'+
        '<td><button class="btn small danger" onclick="window.__delProject(this.dataset.host)" data-host="'+esc(p.host)+'">Удалить</button></td></tr>'+detail;
    }).join('');
    el('projects-table').querySelector('tbody').innerHTML = rows || '<tr><td colspan="7" class="muted">Нет проектов</td></tr>';
  }catch(e){ toast('Проекты: '+e.message,'err'); }
}
LOADERS.projects = loadProjects;
window.__toggleProject = function(i){ var r=el('pdetail-'+i); if(r) r.style.display = r.style.display==='none'?'table-row':'none'; };
el('refresh-projects').addEventListener('click', loadProjects);
window.__delProject = async function(host){ if(!confirm('Удалить ВСЕ файлы проекта «'+host+'»?'))return; try{ await api('/projects/delete',{method:'POST',body:{host:host}}); toast('Проект удалён','ok'); loadProjects(); }catch(e){ toast('Ошибка: '+e.message,'err'); } };
el('cleanup-old').addEventListener('click', async function(){
  var days = Number(el('cleanup-days').value)||90;
  if(!confirm('Удалить запуски старше '+days+' дней во всех проектах?'))return;
  try{ var r = await api('/projects/cleanup',{method:'POST',body:{olderThanDays:days}}); toast('Удалено запусков: '+r.dirs+', файлов: '+r.removed,'ok'); loadProjects(); }
  catch(e){ toast('Ошибка: '+e.message,'err'); }
});

// ---------- Логи ----------
async function loadLogs(){
  try{
    var type = el('log-type').value, lines = Number(el('log-lines').value)||300;
    var r = await fetch(API+'/logs?type='+encodeURIComponent(type)+'&lines='+lines);
    el('log-view').textContent = await r.text();
  }catch(e){ el('log-view').textContent = 'Ошибка: '+e.message; }
}
LOADERS.logs = loadLogs;
if(el('refresh-logs')) el('refresh-logs').addEventListener('click', loadLogs);
if(el('log-type')) el('log-type').addEventListener('change', loadLogs);
if(el('download-logs')) el('download-logs').addEventListener('click', function(){ var type=el('log-type').value, lines=Number(el('log-lines').value)||300; window.open(API+'/logs?download=1&type='+encodeURIComponent(type)+'&lines='+lines,'_blank'); });
if(el('clear-logs')) el('clear-logs').addEventListener('click', async function(){
  if(!confirm('Очистить журнал аудита (включая ротации)?'))return;
  try{ await api('/logs-clear',{method:'POST',body:{}}); toast('Журнал очищен','ok'); loadLogs(); }
  catch(e){ toast('Ошибка: '+e.message,'err'); }
});

// ---------- Бэкапы ----------
var backupWasRunning = false;
async function loadBackups(){
  try{
    var d = await api('/backups');
    el('backups-table').querySelector('tbody').innerHTML = (d.archives||[]).map(function(a){
      return '<tr><td>'+esc(a.name)+'</td><td>'+esc(fmtSize(a.size))+'</td><td>'+esc(fmtDate(a.mtime))+'</td>'+
        '<td><a class="btn small" href="'+API+'/download-archive?name='+encodeURIComponent(a.name)+'">Скачать</a></td></tr>';
    }).join('') || '<tr><td colspan="4" class="muted">Архивов нет</td></tr>';
    var disk = d.disk||{};
    el('disk-box').innerHTML = 'Результаты: <b>'+esc(fmtSize(disk.results||0))+'</b> · Архивы: <b>'+esc(fmtSize(disk.archives||0))+'</b> · Свободно на диске: <b>'+esc(disk.freeHuman||'—')+'</b>';
    el('backup-status').textContent = d.running ? ('Создаётся… '+(d.message||'')) : (d.message||'');
    var btn = el('run-backup');
    if(btn) btn.disabled = !!d.running;
    if(backupWasRunning && !d.running){
      if(/^готово/i.test(d.message||'')) toast('Архив готов: '+String(d.message).replace(/^готово:\s*/i,''),'ok');
      else toast('Бэкап: '+(d.message||'завершено'),'err');
    }
    backupWasRunning = !!d.running;
    if(d.running) setTimeout(loadBackups, 3000);
  }catch(e){ toast('Бэкапы: '+e.message,'err'); }
}
LOADERS.backups = loadBackups;
if(el('refresh-backups')) el('refresh-backups').addEventListener('click', loadBackups);
if(el('run-backup')) el('run-backup').addEventListener('click', async function(){
  if(!confirm('Создать архив SEO-центра? Это может занять время.'))return;
  try{
    await api('/backup',{method:'POST',body:{}});
    backupWasRunning = true;
    toast('Создание архива запущено — сообщу, когда будет готово','ok');
    if(el('backup-status')) el('backup-status').textContent = 'Создаётся…';
    setTimeout(loadBackups, 1200);
  }
  catch(e){ toast('Ошибка: '+e.message,'err'); }
});

// ---------- Статус «требуется перезагрузка» + кнопка рестарта (только IT) ----------
async function healthPid(){ try{ var r=await fetch('/api/health',{cache:'no-store'}); if(r.ok){ return (await r.json()).pid; } }catch(e){} return null; }
function showRestartOverlay(msg){ var o=el('restart-overlay'); if(!o) return; if(msg) el('restart-text').textContent=msg; o.style.display='flex'; }
async function checkRestart(){
  if(!el('restart-banner')) return;
  try{
    var d = await api('/restart-status');
    var b = el('restart-banner');
    if(d && d.needed){
      b.style.display = 'flex';
      b.innerHTML = '<span>⚠ Требуется применить правки: изменён код ('+esc((d.changed||[]).join(', '))+'). Изменения вступят в силу после перезапуска сервиса.</span>'+
        '<button class="btn primary" id="restart-btn2">'+RESTART_LABEL+'</button>';
      var b2 = el('restart-btn2'); if(b2) b2.addEventListener('click', doRestart);
    } else {
      b.style.display = 'none';
    }
  }catch(e){}
}
async function doRestart(){
  if(!confirm((IS_TEST_ENV ? 'Перезагрузить тестовый сервис?' : 'Залить правки на боевой сервис?') + ' Панель на несколько секунд станет недоступна.')) return;
  var oldPid = await healthPid();
  showRestartOverlay('Перезагружаю сервис…');
  try{ await fetch(API+'/restart',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); }catch(e){}
  var tries = 0;
  var timer = setInterval(async function(){
    tries++;
    var pid = await healthPid();
    if(pid && pid !== oldPid){
      clearInterval(timer);
      el('restart-text').textContent = 'Готово, обновляю страницу…';
      setTimeout(function(){ location.reload(); }, 700);
      return;
    }
    if(tries > 120){ clearInterval(timer); el('restart-text').textContent = 'Не дождался сервиса. Обнови страницу вручную (F5).'; }
  }, 1000);
}
if(el('restart-btn')) el('restart-btn').addEventListener('click', doRestart);
checkRestart();
setInterval(checkRestart, 8000);

switchTab('overview');
</script>
</body>
</html>`
}

export interface SeoPanelOpts {
  // Клиент opencode. Может быть in-process клиентом плагина или клиентом
  // @opencode-ai/sdk, подключённым к `opencode serve` (развязанный режим).
  client: any
  directory?: string
  projectDir?: string
}

export interface SeoPanelHandle {
  stop: () => void
  handleEvent: (event: any) => Promise<void>
}

// Создаёт панель SEO-центра на переданном клиенте opencode: HTTP-сервер,
// очередь, проекты. Так панель можно запускать и из плагина (in-process),
// и из отдельного процесса-панели (клиент SDK).
export async function createSeoPanel(opts: SeoPanelOpts): Promise<SeoPanelHandle> {
  // opencode вызывает ВСЕ экспортированные функции модуля как плагины, передавая
  // туда {client, project, directory}. Отличаем настоящий вызов по projectDir,
  // который передают только наши обёртки (плагин и отдельный процесс).
  if (typeof opts?.projectDir !== "string" || !opts.projectDir) {
    return { stop: () => {}, handleEvent: async () => {} }
  }
  getAuthSecret()
  const client = opts.client
  const projectDir = opts.projectDir
  // Все результаты SEO-центра лежат в проекте, в котором запущен инстанс
  // opencode (теперь это проект «SEO-центр»): <projectDir>/seo-results.
  // Для тестового инстанса путь переопределяется SEO_RESULTS_DIR, чтобы он не
  // писал в боевые результаты.
  const RESULTS_ROOT = process.env.SEO_RESULTS_DIR
    ? String(process.env.SEO_RESULTS_DIR)
    : join(projectDir, "seo-results")
  const SEARCH_ENV = (process.env.SEO_CENTER_ENV || "").trim().toLowerCase()
  const IS_TEST_INSTANCE = SEARCH_ENV === "test"
  const uploadDir = process.env.SEO_UPLOADS_DIR
    ? String(process.env.SEO_UPLOADS_DIR)
    : join(projectDir, ".opencode", "uploads")
  try {
    mkdirSync(uploadDir, { recursive: true })
    mkdirSync(RESULTS_ROOT, { recursive: true })
  } catch {}
  log("project dir: " + projectDir)
  log("results dir: " + RESULTS_ROOT)
  log("uploads dir: " + uploadDir)

  function formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + " Б"
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " КБ"
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + " МБ"
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " ГБ"
  }

  // ---------- Админ-панель: утилиты ----------
  function dirSizeBytes(dir: string): number {
    let total = 0
    const walk = (d: string) => {
      let entries: any[]
      try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const full = join(d, e.name)
        try {
          if (e.isDirectory()) walk(full)
          else if (e.isFile()) total += statSync(full).size
        } catch {}
      }
    }
    walk(dir)
    return total
  }

  function tailLines(file: string, lines: number): string {
    try {
      if (!existsSync(file)) return "(файл не найден)"
      const data = readFileSync(file, "utf8").split("\n")
      return data.slice(-Math.max(1, lines)).join("\n")
    } catch (e) { return "Ошибка чтения: " + String(e) }
  }

  function freeDiskHuman(): string {
    try {
      const s: any = statfsSync(projectDir)
      return formatSize(Number(s.bavail) * Number(s.bsize))
    } catch { return "—" }
  }

  function fmtUptime(sec: number): string {
    sec = Math.floor(sec)
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60)
    if (d) return d + " д " + h + " ч"
    if (h) return h + " ч " + m + " мин"
    return m + " мин"
  }

  function runCmdCapture(cmd: string, args: string[], timeoutMs = 8000): Promise<string> {
    return new Promise((resolve) => {
      try {
        const p = spawn(cmd, args, { env: process.env })
        let buf = ""
        const to = setTimeout(() => { try { p.kill() } catch {} resolve(buf) }, timeoutMs)
        p.stdout?.on("data", (d: any) => { buf += d.toString() })
        p.stderr?.on("data", (d: any) => { buf += d.toString() })
        p.on("close", () => { clearTimeout(to); resolve(buf) })
        p.on("error", () => { clearTimeout(to); resolve(buf) })
      } catch (e) { resolve(String(e)) }
    })
  }

  // Нужна ли перезагрузка сервиса: код плагина менялся после запуска процесса.
  function pluginRestartStatus(): { needed: boolean; changed: string[]; startedAt: number; now: number } {
    const startMs = Date.now() - Math.round(process.uptime() * 1000)
    const dir = join(projectDir, ".opencode", "plugin")
    const changed: string[] = []
    try {
      for (const n of readdirSync(dir)) {
        if (!/\.(ts|js)$/.test(n)) continue
        try {
          const st = statSync(join(dir, n))
          if (st.mtimeMs > startMs + 2000) changed.push(n)
        } catch {}
      }
    } catch {}
    return { needed: changed.length > 0, changed, startedAt: startMs, now: Date.now() }
  }

  function listArchives(): any[] {
    const dir = join(projectDir, "seo-center-archives")
    const out: any[] = []
    try {
      for (const n of readdirSync(dir)) {
        if (!/\.(tar\.gz|tar\.gz\.enc|enc)$/.test(n)) continue
        const full = join(dir, n)
        try {
          // Пропускаем симлинки (например latest.tar.gz.enc) — это ярлык на
          // версионный архив, в списке он только дублирует строку.
          if (lstatSync(full).isSymbolicLink()) continue
          const st = statSync(full)
          if (st.isFile()) out.push({ name: n, size: st.size, mtime: Math.round(st.mtimeMs) })
        } catch {}
      }
    } catch {}
    out.sort((a, b) => b.mtime - a.mtime)
    return out
  }

  function ctypeFor(e: string): string {
    switch (e.toLowerCase()) {
      case ".csv": return "text/csv; charset=utf-8"
      case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      case ".xls": return "application/vnd.ms-excel"
      case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      case ".doc": return "application/msword"
      case ".md": return "text/markdown; charset=utf-8"
      case ".html": return "text/html; charset=utf-8"
      default: return "application/octet-stream"
    }
  }

  let activeSessionID: string | undefined

  // Возвращает сессию для проекта (по URL/хосту). Один проект — одна сессия.
  // Если для проекта сессии ещё нет — создаёт новую.
  async function sessionForProject(key: string): Promise<string> {
    const norm = projectKeyFrom(key)
    const existing = projectSessions.get(norm)
    if (existing) return existing
    const created = await client.session.create({ body: { title: "SEO · " + norm } })
    const id = created.data?.id ?? created?.data?.id ?? (created as any)?.id
    if (id) projectSessions.set(norm, id)
    activeSessionID = id
    return id
  }

  // Правило: браузерные задачи выполняем в НОВОЙ вкладке, не трогаем уже открытые.
  const TAB_RULE =
    "\n\nВАЖНО (правила SEO-центра):\n" +
    "- Для работы в браузере ВСЕГДА открывай новую вкладку/страницу (новый page). " +
    "НЕ используй и НЕ перезаписывай уже открытые вкладки пользователя.\n" +
    "- Задачи по одному проекту (определяется по URL/хосту) идут в одной сессии, " +
    "по разным URL — в разных сессиях."

  async function sendPrompt(prompt: string, taskId?: string, projectKey?: string, model?: { providerID: string; modelID: string }): Promise<void> {
    let key = projectKey
    // Сессии сотрудников не смешиваются: ключ проекта дополняется владельцем,
    // чтобы агент одного пользователя не видел контекст другого.
    let owner = ""
    let t: TaskState | undefined
    if (taskId) {
      t = tasksStore.get(taskId)
      if (!key) key = t?.host
      if (t?.owner && t.owner !== "admin") owner = t.owner
    }
    const norm = projectKeyFrom(key)
    const scoped = owner ? owner + "::" + norm : norm
    const sessionID = await sessionForProject(scoped)
    if (taskId) {
      taskSessions.set(taskId, sessionID)
      sessionTasks.set(sessionID, taskId)
      updateTask(taskId, { message: "Отправляю задание в opencode…", sessionID })
    }
    // Модель: явная → как передали; иначе бесплатная для «скриптовых» навыков
    // из FREE_TOOLS; иначе — основная.
    let chosen = model
    const freeModel = currentFreeModel()
    if (!chosen && t && currentFreeTools().has(t.tool)) chosen = freeModel
    const finalModel = chosen || currentMainModel()
    if (t) t.usedFree = finalModel.modelID === freeModel.modelID
    await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        model: finalModel,
        parts: [{ type: "text", text: prompt + TAB_RULE }],
      },
    })
    log("sent prompt to session " + sessionID + " (project " + scoped + ", model " + finalModel.modelID + ")")
    if (taskId) updateTask(taskId, { message: "Задание запущено в сессии opencode", lastPrompt: prompt })
  }

  // Безопасный откат: если задача шла на бесплатной модели и упала — один раз
  // повторяем тот же промпт на основной модели. У аудита свой каскад (free1→free2→flash).
  function escalateToPaid(t?: TaskState): boolean {
    if (!t || !t.usedFree || t.escalated || !t.lastPrompt) return false
    if (t.auditJobId || auditFollowups.has(t.id)) return false
    t.escalated = true
    t.usedFree = false
    clearIdleTimer(t.id)
    updateTask(t.id, { status: "running", message: "Бесплатная модель не справилась — повтор на платной…" })
    void sendPrompt(t.lastPrompt, t.id, t.host, currentMainModel()).catch((e) => log("escalation failed: " + String(e)))
    return true
  }

  // ---------- Очередь аудитов: запуск задания и продвижение очереди ----------
  function launchAuditJob(job: AuditJob): void {
    job.status = "running"
    job.startedAt = Date.now()
    scheduleQueueSave()
    auditRunning++
    const scriptPts = job.points.filter((p) => SCRIPT_POINTS.has(p.point))
    const modelPts = job.points.filter((p) => !SCRIPT_POINTS.has(p.point))
    if (scriptPts.length && modelPts.length) {
      const t = newTask("auditfull", job.label + " · данные")
      t.owner = job.owner; t.host = job.host; t.outDir = job.outDir; t.tab = "a-results"; t.auditJobId = job.id
      job.currentTaskId = t.id
      auditFollowups.set(t.id, { prompt: job.modelPrompt, label: job.label + " · выводы", host: job.host,
        outDir: job.outDir, owner: job.owner, scriptPrompt: job.scriptPrompt, freeStage: 0, jobId: job.id,
        site: job.site, scriptPts })
      void sendPrompt(job.scriptPrompt, t.id, undefined, currentFreeModel())
    } else if (scriptPts.length) {
      const t = newTask("auditfull", job.label + " · данные")
      t.owner = job.owner; t.host = job.host; t.outDir = job.outDir; t.tab = "a-results"; t.auditJobId = job.id
      job.currentTaskId = t.id
      auditFollowups.set(t.id, { prompt: job.assemblyOnlyPrompt, label: job.label + " · выводы", host: job.host,
        outDir: job.outDir, owner: job.owner, scriptPrompt: job.scriptPrompt, freeStage: 0, jobId: job.id,
        site: job.site, scriptPts })
      void sendPrompt(job.scriptPrompt, t.id, undefined, currentFreeModel())
    } else {
      const t = newTask("auditfull", job.label)
      t.owner = job.owner; t.host = job.host; t.outDir = job.outDir; t.tab = "a-results"; t.auditJobId = job.id
      job.currentTaskId = t.id
      void sendPrompt(job.modelPrompt, t.id, undefined, currentMainModel())
    }
    log("audit job started: " + job.id + " (" + job.host + ")")
  }

  function pumpAuditQueue(): void {
    while (auditRunning < auditMaxConcurrent()) {
      const next = [...auditJobs.values()].filter((j) => j.status === "queued").sort((a, b) => a.enqueuedAt - b.enqueuedAt)[0]
      if (!next) return
      launchAuditJob(next)
    }
  }

  function finishAuditJob(jobId?: string): void {
    if (!jobId) return
    const job = auditJobs.get(jobId)
    if (!job || job.status !== "running") return
    recordAuditRun(job)
    // Помечаем завершённым перед удалением — для очереди и лога виден финальный статус.
    job.status = "done"
    auditJobs.delete(jobId)
    scheduleQueueSave()
    auditRunning = Math.max(0, auditRunning - 1)
    log("audit job finished: " + jobId + " (осталось активно " + auditRunning + ")")
    setTimeout(() => { try { pumpAuditQueue() } catch {} }, 800)
  }

  // Дебаунс завершения. session.idle приходит не только в самом конце, но и
  // между шагами/в ожидании — помечать задачу «выполнено» сразу нельзя: иначе
  // статус-бар показывает 100% и кнопку результатов, пока идёт работа.
  // Ждём паузу без активности: любое новое событие сбрасывает таймер.
  const idleTimers = new Map<string, any>()
  function clearIdleTimer(id: string): void {
    const tm = idleTimers.get(id)
    if (tm) { clearTimeout(tm); idleTimers.delete(id) }
  }
  function scheduleTaskDone(id: string, delay = 5000): void {
    clearIdleTimer(id)
    log(`[diag] scheduleTaskDone(${id})`)
    const tm = setTimeout(() => {
      idleTimers.delete(id)
      const t = tasksStore.get(id)
      log(`[diag] done-timer fired ${id}: status=${t ? t.status : "none"}`)
      if (!t || t.status !== "running") return
      const pol = articlePolishes.get(id)
      log(`[diag] polish lookup ${id}: ${pol ? (pol.done ? "done" : "pending") : "none"}`)
      if (pol && !pol.done) {
        pol.done = true
        log(`[articles] запускаю полировку (${SEO_CENTER_MODEL_POLISH.providerID}/${SEO_CENTER_MODEL_POLISH.modelID}) для ${id}`)
        updateTask(id, { message: "Черновики готовы. Копирайтерская полировка (Max)…" })
        void sendPrompt(buildArticlePolishPrompt(pol.outDir), id, t.host, SEO_CENTER_MODEL_POLISH)
          .catch((e) => { log("article polish failed: " + String(e)); updateTask(id, { status: "done", message: "Задание выполнено (без полировки)" }) })
        return
      }
      if (pol) articlePolishes.delete(id)
      updateTask(id, { status: "done", message: "Задание выполнено" })
      invalidateProjectsIndex()
      if (t.auditJobId) finishAuditJob(t.auditJobId)
    }, delay)
    idleTimers.set(id, tm)
  }
  function markTaskActive(id: string): void {
    clearIdleTimer(id)
    const t = tasksStore.get(id)
    if (t && t.status !== "running") updateTask(id, { status: "running" })
  }

  // Промпт второго прохода для статей: полировка стиля на Max-модели.
  // Полируем ТОЛЬКО прозу (стиль/читабельность), сохраняя смысл, структуру H1–H3,
  // ключевые фразы (жёлтая подсветка), метатеги и объём ±10%. Это оптимизирует
  // расход: переписывается текст, а не генерируется заново.
  function buildArticlePolishPrompt(rootDir: string): string {
    return `Второй этап навыка статей — КОПИРАЙТЕРСКАЯ ПОЛИРОВКА (только стиль, без переписывания по смыслу).

Папка с готовыми материалами: ${rootDir}
В ней материалы в .docx и рядом одноимённые .meta.json (ищи рекурсивно, включая подпапку articles/).

Для КАЖДОЙ статьи:
1) Прочитай .docx (python-docx) и одноимённый .meta.json.
2) Отредактируй ТОЛЬКО прозу до уровня опытного копирайтера: живые формулировки, ясность, ритм, логичные связки; убери ИИ-штампы, канцелярит и воду. Факты, смысл, структуру H1–H3 и ВСЕ ключевые фразы из meta.json — СОХРАНИ. Заголовки можно слегка отшлифовать, не меняя смысл.
3) Каждое точное вхождение ключевой фразы — подсветить жёлтым (через <mark> и скрипты навыка ${SKILL_ARTICLES}: scripts/highlight_keywords.py + scripts/html_to_docx.py), пересобрать .docx и ПЕРЕЗАПИСАТЬ тот же файл. Можно править python-docx напрямую, сохранив жёлтую подсветку.
4) Объём — в пределах ±10% от исходного (по content_length_with_spaces). Не растягивай ради объёма.
5) Обнови .meta.json (content_length, content_length_with_spaces) и запись в articles.json.
6) meta_title/meta_description не трогай (меняй только поля длины при необходимости).

Правила языка: без пустых зачинов и канцелярита, без промо-эпитетов-пустышек, не обрывай фразы, без «синонимической карусели».

В конце создай пустой маркер ${rootDir}/.polish_done и выведи список обработанных файлов. Файлы — только внутри ${rootDir}. Не создавай новых статей и не меняй их количество.`
  }

  function buildMetaTagsPrompt(cmd: string, path: string, newMeta: boolean, outDir: string): string {
    const mode = newMeta
      ? "Составь новые title и description."
      : "Выполни задание без генерации новых метатегов."
    return `Запусти навык ${cmd} (см. SKILL.md) и выполни задание.

${mode}

Файл семантического ядра: ${path}

Правила:
- Прочитай файл семантического ядра (.xlsx или .csv), определи целевые страницы.
${newMeta ? "- Составь оптимизированные title (с разделителем | и названием компании) и description (с точкой на конце)." : ""}
- Сохрани итоговые файлы (Метатеги_новые_<хост>.xlsx и .csv) ТОЛЬКО в эту папку:
${outDir}
НЕ создавай и не записывай файлы в других местах.
Выведи в чат путь к итоговым файлам.`
  }

  // ---------- Аудит: промпты и постановка в очередь ----------
  // Одна сборка промптов на все входы: форма /run-audit, «Повторить» из истории
  // и планировщик. Иначе повтор и расписание разошлись бы с обычным аудитом.
  function buildAuditPrompts(args: {
    site: string; outDir: string; points: { point: string; skill: string }[]
    depthContent: number; depthSpeed: number; semcoreMsg: string
  }): { scriptPrompt: string; modelPrompt: string; assemblyOnlyPrompt: string } {
    const { site, outDir, points, depthContent, depthSpeed, semcoreMsg } = args
    const hasPoint = (pt: string) => points.some((p) => p.point === pt)
    const scriptPts = points.filter((p) => SCRIPT_POINTS.has(p.point))
    const modelPts = points.filter((p) => !SCRIPT_POINTS.has(p.point))
    const scriptList = scriptPts.map((p) => `- п. ${p.point} — навык ${p.skill}`).join("\n")
    const modelList = modelPts.map((p) => `- п. ${p.point} — навык ${p.skill}`).join("\n")
    const depthMsgContent = hasPoint("2.1")
      ? `\nПункт 2.1 «Текстовый контент» — глубина: не более ${depthContent} страниц. ` +
        `Отбирай наиболее важные/популярные страницы: главная, разделы/каталоги, карточки товаров/услуг, несколько статей/новостей. ` +
        `(В скрипте навыка параметр --limit=${depthContent}.) ` +
        (depthContent > 1000 ? `Указано больше 1000 — проверяй ВСЕ страницы сайта (это очень долго).\n` : `\n`)
      : ""
    const depthMsgSpeed = hasPoint("4.1")
      ? `\nПункт 4.1 «Скорость загрузки страниц» — глубина: не более ${depthSpeed} страниц. ` +
        `По умолчанию проверяй главную, «О компании», каталоги/разделы, разводящие страницы, контакты, карточки и другие важные страницы. ` +
        `(В скрипте навыка параметр --limit=${depthSpeed}.) ` +
        (depthSpeed > 1000 ? `Указано больше 1000 — проверяй ВСЕ страницы сайта (это очень долго).\n` : `\n`)
      : ""
    const depthMsg = depthMsgContent + depthMsgSpeed
    const rulesPath = join(projectDir, ".opencode", "rules", "audit-rules.md")

    const structureRules = [
      `Правила отчёта и audit.json — прочитай файл и выполни буквально: ${rulesPath}`,
      "Коротко, что нельзя нарушать:",
      "- В каждом пункте указывай, сколько страниц проверено; «Положительное» — отдельным блоком до недостатков; к рекомендации — 1 буквальный пример.",
      "- Нумеруй только выбранные пункты сквозной нумерацией (1.1, 1.2 … 2.1 …), неотмеченные в документ не включай.",
      "- Титульный лист: только название аудита, домен и дата.",
      "- Помимо «SEO-аудит.docx» сохрани в папку audit.json по схеме из файла правил: панель считает по нему скор, историю, дельту, статусы проблем и уведомления.",
      "- Таблицы XLSX: пункты 2.1–2.5 и 3.2 → «Контент_<хост>.xlsx»; пункт 4.1 → «Скорость_<хост>.xlsx». Пустые не создавай.",
      "",
      "СОХРАНИ единый итоговый .docx под именем «SEO-аудит.docx» ТОЛЬКО В ЭТУ ПАПКУ:",
      outDir,
      "",
      "НЕ создавай и не записывай файлы в других местах. Выведи в чат путь к файлу и краткую сводку по каждому включённому пункту.",
    ].join("\n")

    const scriptPrompt = `Первый этап SEO-аудита: выполни СКРИПТОВЫЕ пункты (результаты — в папку).

Сайт: ${site}
Папка результатов: ${outDir}

Пункты (для каждого прочитай SKILL.md соответствующего навыка и выполни его скрипт):
${scriptList}
${depthMsg}
- Для пункта 2.1 передавай в скрипт --limit=${depthContent}; для пункта 4.1 — --limit=${depthSpeed} (выборка важных страниц).
- Всем скриптам, которые скачивают страницы сайта, передавай --cache "${outDir}/.cache" — общий HTTP-кэш, чтобы не краулить сайт заново на каждом пункте.
- Соблюдай формат результатов каждого навыка: docx по пункту + общий «Контент_<хост>.xlsx» / «Скорость_<хост>.xlsx».
- ЕДИНЫЙ документ НЕ собирай — только разделы по пунктам.
- После КАЖДОГО завершённого пункта создавай пустой файл-маркер ${outDir}/.point_<номер>_done (например .point_2.1_done). Если маркер уже есть — пункт НЕ переделывай.
- В самом конце создай пустой файл-маркер ${outDir}/.scripts_done и выведи список созданных файлов.`

    const modelPrompt = `Второй этап SEO-аудита: модельные пункты + сборка единого документа.

Сайт: ${site}
Папка результатов: ${outDir}
Часть пунктов уже выполнена скриптами на первом этапе — их docx/xlsx лежат в этой папке, используй их.

Модельные пункты (полный сайт; для каждого прочитай SKILL.md и выполни задание):
${modelList}
${semcoreMsg}
После выполнения модельных пунктов собери результаты ВСЕХ выбранных пунктов (и этой задачи, и уже готовые файлы скриптовых пунктов из папки) в ЕДИНЫЙ «SEO-аудит.docx».
${structureRules}`

    const assemblyOnlyPrompt = `Второй этап SEO-аудита: интерпретация, выводы и сборка единого документа.

Сайт: ${site}
Папка результатов: ${outDir}
Все выбранные пункты уже выполнены скриптами — их docx/xlsx лежат в этой папке.

Прочитай готовые разделы из папки, собери результаты ВСЕХ выбранных пунктов в ЕДИНЫЙ «SEO-аудит.docx» и напиши раздел «Общие выводы» (интерпретация и рекомендации — твоя задача).
${structureRules}`

    return { scriptPrompt, modelPrompt, assemblyOnlyPrompt }
  }

  // Постановка аудита в очередь. Возвращает то же, что отдаёт /run-audit.
  function enqueueAudit(args: {
    site: string; points: { point: string; skill: string }[]; owner: string; auth?: AuthInfo | null
    depthContent?: number; depthSpeed?: number; semcoreMsg?: string; semcorePath?: string; scheduled?: boolean
    dryRun?: boolean
  }): any {
    console.log("DEBUG enqueueAudit called, args keys: " + Object.keys(args) + ", has dryRun: " + ("dryRun" in args) + ", args.dryRun: " + args.dryRun + ", args[\"dryRun\"]: " + args["dryRun"])
    const points = (args.points || []).filter((p) => p && p.point && p.skill)
    if (!site) return { ok: false, error: "URL сайта не указан" }
    if (!points.length) return { ok: false, error: "Не выбран ни один пункт аудита" }
    const host = hostFromUrl(site) || deriveHostFromText(site) || "project"
    // Запрет одновременного аудита одного и того же сайта.
    const existing = [...auditJobs.values()].find((j) => j.host === host)
    if (existing) {
      return { ok: false, error: existing.status === "running"
        ? "Аудит этого сайта уже запущен и выполняется. Дождитесь завершения."
        : "Аудит этого сайта уже стоит в очереди." }
    }
    const outDir = makeRunDir(host, args.auth ?? null, { category: "audit", task: "audit" })
    const depthContent = args.depthContent ?? 50
    const depthSpeed = args.depthSpeed ?? 10
    const semcoreMsg = args.semcoreMsg ?? ""
    const { scriptPrompt, modelPrompt, assemblyOnlyPrompt } = buildAuditPrompts({
      site, outDir, points, depthContent, depthSpeed, semcoreMsg,
    })
    const job: AuditJob = {
      id: newAuditJobId(), site, host, outDir, owner: args.owner,
      label: "SEO-аудит — " + site, points, status: "queued", enqueuedAt: Date.now(),
      scriptPrompt, modelPrompt, assemblyOnlyPrompt, scheduled: args.scheduled,
      depthContent, depthSpeed, semcoreMsg, semcorePath: args.semcorePath,
      dryRun: args["dryRun"],
    }
    auditJobs.set(job.id, job)
    scheduleQueueSave()
    if (!args.dryRun) {
      pushHistory({ at: nowIso(), user: job.owner, tool: "audit", site: host, status: "queued", jobId: job.id })
    }
    if (auditRunning < auditMaxConcurrent()) {
      launchAuditJob(job)
      const result = { ok: true, host, outDir, jobId: job.id, taskId: job.currentTaskId,
        queued: false, running: auditRunning, max: auditMaxConcurrent(), dryRun: args.dryRun === true }
      return result
    }
    const queued = [...auditJobs.values()].filter((j) => j.status === "queued").sort((a, b) => a.enqueuedAt - b.enqueuedAt)
    const position = queued.findIndex((j) => j.id === job.id) + 1
    const result2 = { ok: true, host, outDir, jobId: job.id, queued: true, position,
      eta: fmtEta(auditEtaMinutes(position)), running: auditRunning, max: auditMaxConcurrent(), dryRun: args.dryRun === true }
    return result2

  // ---------- Результат прогона: audit.json → история, проблемы, Telegram ----------
  function readAuditReport(dir: string): AuditReport | null {
    for (const name of ["audit.json", "Audit.json"]) {
      const p = join(dir, name)
      if (!existsSync(p)) continue
      try { return normalizeAuditReport(JSON.parse(readFileSync(p, "utf8"))) } catch { return null }
    }
    return null
  }

  function recordAuditRun(job: AuditJob): void {
    try {
      const report = readAuditReport(job.outDir)
      const score = report ? scoreAudit(report) : null
      const run: RunRecord = {
        id: job.id, host: job.host, site: job.site, at: new Date().toISOString(),
        dir: job.outDir, points: job.points.map((p) => p.point),
        score: score ? score.score : null, gate: score ? score.gate : "unknown",
        counts: score ? score.counts : null, jobId: job.id, scheduled: job.scheduled,
        depthContent: job.depthContent, depthSpeed: job.depthSpeed,
        semcoreMsg: job.semcoreMsg, semcorePath: job.semcorePath,
        sitemapCoverage: report?.sitemapCoverage ?? null,
      }
      const prev = readRuns(RESULTS_ROOT).runs.filter((r) => r.host === job.host).slice(-1)[0] || null
      const prevReport = prev ? readAuditReport(prev.dir) : null
      if (!job.dryRun) {
        appendRun(RESULTS_ROOT, run)
        if (report) {
          const store = readIssues(RESULTS_ROOT)
          applyReport(store, job.host, report, job.id)
          writeIssues(RESULTS_ROOT, store)
        }
        const delta = report ? diffReports(prevReport, report) : null
        const settings = readSettings(RESULTS_ROOT)
        void telegramNotify(settings, formatRunMessage(job.host, run, delta)).catch(() => {})
      }
    } catch (e) {
      log("recordAuditRun failed: " + String(e))
    }
  }

  function pointRefs(points: string[]): { point: string; skill: string }[] {
    return points.map((p) => ({ point: p, skill: POINT_SKILLS[p] })).filter((p) => p.skill)
  }

  // Планировщик: раз в 10 минут проверяем, какие расписания пора запустить.
  // lastRunAt двигаем только после успешной постановки — иначе повторяем на
  // следующем тике (например, сайт уже в очереди).
  function startAuditScheduler(): void {
    const tick = () => {
      try {
        const settings = readSettings(RESULTS_ROOT)
        for (const sch of dueSchedules(settings, Date.now())) {
          const last = lastRun(RESULTS_ROOT, sch.site)
          const r = enqueueAudit({ site: sch.site, points: sch.points, owner: "admin", scheduled: true,
            depthContent: sch.depthContent ?? (last?.depthContent ?? 50),
            depthSpeed: sch.depthSpeed ?? (last?.depthSpeed ?? 10) })
          if (r.ok) {
            sch.lastRunAt = new Date().toISOString()
            saveSettings(RESULTS_ROOT, { schedules: settings.schedules })
            log(`scheduler: запущен аудит ${sch.site}`)
          }
        }
      } catch (e) { log("scheduler: " + String(e)) }
    }
    const t = setTimeout(tick, 60_000)
    const i = setInterval(tick, 10 * 60_000)
    ;(t as any).unref?.(); (i as any).unref?.()
  }

  const textDecoder = new TextDecoder()

  const MAX_JSON_BODY = 2 * 1024 * 1024 // 2 МБ на JSON-тело
  async function readBody(req: Request): Promise<any> {
    const len = parseInt(req.headers.get("content-length") || "0", 10)
    if (len && len > MAX_JSON_BODY) throw new Error("Тело запроса слишком большое")
    const buf = await req.arrayBuffer()
    if (buf.byteLength > MAX_JSON_BODY) throw new Error("Тело запроса слишком большое")
    // Некорректный JSON не должен валить обработчик — отдаём пустой объект.
    try { return JSON.parse(textDecoder.decode(buf)) } catch { return {} }
  }

  const SKIP_DIRS = new Set(["node_modules", ".git", ".opencode", "dist", "build", ".venv", "venv", "_raw"])

  function scanResults(dir: string): any[] {
    const out: any[] = []
    function walk(d: string): void {
      let entries: string[]
      try {
        entries = readdirSync(d)
      } catch {
        return
      }
      for (const name of entries) {
        const full = join(d, name)
        let st: ReturnType<typeof statSync>
        try {
          st = lstatSync(full)
        } catch {
          continue
        }
        if (st.isSymbolicLink()) continue
        if (st.isDirectory()) {
          if (!SKIP_DIRS.has(name)) walk(full)
        } else if (RESULTS_EXTS.includes(ext(name).toLowerCase())) {
          out.push({ name, rel: relative(dir, full), size: st.size, mtime: st.mtimeMs })
        }
      }
    }
    walk(dir)
    out.sort((a, b) => b.mtime - a.mtime)
    return out
  }

  function ext(name: string): string {
    const i = name.lastIndexOf(".")
    return i >= 0 ? name.slice(i) : ""
  }

  // Full RFC-4180 CSV parser: handles quoted fields, escaped quotes ("") and
  // embedded newlines inside quotes — so multi-line cells don't split rows.
  function parseCsv(text: string): string[][] {
    const src = text.replace(/^\uFEFF/, "")
    const firstLine = src.split(/\r?\n/, 1)[0] || ""
    const delim = firstLine.includes(";") ? ";" : ","
    const rows: string[][] = []
    let row: string[] = []
    let field = ""
    let inQuotes = false
    for (let i = 0; i < src.length; i++) {
      const ch = src[i]
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') {
            field += '"'
            i++
          } else {
            inQuotes = false
          }
        } else {
          field += ch
        }
      } else if (ch === '"') {
        inQuotes = true
      } else if (ch === delim) {
        row.push(field)
        field = ""
      } else if (ch === "\n") {
        row.push(field)
        rows.push(row)
        row = []
        field = ""
      } else if (ch === "\r") {
        // skip; \r\n handled by the following \n
      } else {
        field += ch
      }
    }
    // last field / row
    if (field.length > 0 || row.length > 0) {
      row.push(field)
      rows.push(row)
    }
    return rows.filter((r) => r.some((c) => c.trim().length > 0)).slice(0, 200)
  }

  function hostFromUrl(raw: string): string | null {
    try {
      const u = new URL(raw.includes("://") ? raw : "http://" + raw)
      return u.hostname
    } catch {
      return null
    }
  }

  function sanitizeHost(host: string): string {
    return host.toLowerCase().replace(/[^a-z0-9.\-]+/g, "_").replace(/^\.+|\.+$/g, "")
  }

  // Категории, задаваемые подпапкой запуска: seo-results/<host>/<дата>_<время>/<категория>/…
  // Надёжнее имени файла: например «Микроразметка_*.xlsx», созданная SEO-аудитом,
  // лежит в папке audit/ и должна показываться в результатах аудита, а не инструментов.
  const RUN_FOLDER_CATS = new Set(["audit", "extract", "metatags", "wordstat", "topics", "articles", "microdata", "smm"])

  function classifyFile(name: string, extLower: string, relPath: string, runIsAudit = false): string {
    const base = name.toLowerCase()
    const pathLower = String(relPath || "").toLowerCase()
    // Папка запуска (новый формат) имеет приоритет над именем файла.
    const firstSeg = pathLower.split("/")[0]
    if (firstSeg && RUN_FOLDER_CATS.has(firstSeg)) return firstSeg
    // Легаси-прогоны (плоский формат <host>_<дата>_<время>) не имеют подпапки
    // категории. Если в прогоне есть артефакты аудита (SEO-аудит.docx / по-
    // пунктовые docx) — все таблицы прогона принадлежат аудиту, включая
    // «Микроразметка_*.xlsx». Так результаты инструментов и аудита не пересекаются.
    if (runIsAudit) return "audit"
    // Anything under an articles/ subfolder is an article deliverable
    // (.docx now, .html from older runs), not an audit document.
    if (/(^|\/)articles\//.test(pathLower)) return "articles"
    if (base === "articles.json") return "articles"
    if (base.startsWith("темы_для_блога")) return "topics"
    if (base.startsWith("wordstat_")) return "wordstat"
    if (base.startsWith("smm_") || base.startsWith("smm ") || base.startsWith("анализ_групп") || base.startsWith("анализ групп")) return "smm"
    if (base.startsWith("метатеги_новые")) return "metatags"
    if (base.startsWith("микроразметка")) return "microdata"
    if (base.startsWith("метатеги_") || base.startsWith("заголовки_")) return "extract"
    // Таблицы, которые создаёт SEO-аудит (контент, скорость) — это результаты аудита, не инструментов.
    if (base.startsWith("контент_") || base.startsWith("скорость_")) return "audit"
    if (extLower === ".docx" || extLower === ".doc") return "audit"
    return "other"
  }

  function pad(n: number): string {
    return String(n).padStart(2, "0")
  }

  function todayStamp(): string {
    const d = new Date()
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  function timeStamp(): string {
    const d = new Date()
    return `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  }

  // Владелец папки результатов. Пишется в скрытый файл .seo-owner, чтобы
  // сотрудник видел только свои запуски, а администратор — все.
  const OWNER_FILE = ".seo-owner"

  function ownerFilePath(dir: string): string {
    return join(dir, OWNER_FILE)
  }

  function readOwner(dir: string): string | null {
    try {
      const p = ownerFilePath(dir)
      if (!existsSync(p)) return null
      const v = readFileSync(p, "utf8").trim()
      return v || null
    } catch {
      return null
    }
  }

  function writeOwner(dir: string, auth?: AuthInfo | null): void {
    if (!dir || !auth) return
    try {
      if (!existsSync(dir)) return
      writeFileSync(ownerFilePath(dir), (hasGlobalAccess(auth) ? "admin" : auth.uid) + "\n")
    } catch (e) {
      log("не удалось записать владельца результатов: " + String(e))
    }
  }

  // Манифест запуска (.seo-meta.json) — хранит host/категорию/владельца рядом с
  // файлами, чтобы не угадывать их по имени. Читается при сканировании.
  const META_FILE = ".seo-meta.json"
  function writeRunMeta(dir: string, meta: Record<string, unknown>): void {
    try {
      writeFileSync(join(dir, META_FILE), JSON.stringify(meta, null, 2) + "\n")
    } catch (e) {
      log("не удалось записать манифест запуска: " + String(e))
    }
  }
  function readRunMeta(dir: string): any | null {
    try {
      const p = join(dir, META_FILE)
      if (!existsSync(p)) return null
      return JSON.parse(readFileSync(p, "utf8"))
    } catch {
      return null
    }
  }

  // Формат папки запуска: legacy <host>_<YYYY-MM-DD>_<HHMMSS> и новый
  // <host>/<YYYY-MM-DD>_<HH-MM-SS>. Нормализуем время к HH:MM:SS.
  const LEGACY_RUN_RE = /^(.+?)_(\d{4}-\d{2}-\d{2})(?:_(\d{2}-?\d{2}-?\d{2})(?:_\d+)?)?$/
  const RUN_STAMP_RE = /^(\d{4}-\d{2}-\d{2})[_-](\d{2}-?\d{2}-?\d{2})(?:_\d+)?$/
  function normTime(t?: string): string {
    const s = String(t || "")
    if (!s) return ""
    if (s.includes(":")) return s
    const d = s.replace(/-/g, "")
    return d.length === 6 ? `${d.slice(0, 2)}:${d.slice(2, 4)}:${d.slice(4, 6)}` : s
  }

  // Единый список папок запусков в обоих форматах (для сканирования и удаления).
  function listRuns(): { host: string; folder: string; abs: string; date: string; time: string }[] {
    const root = RESULTS_ROOT
    const out: { host: string; folder: string; abs: string; date: string; time: string }[] = []
    if (!existsSync(root)) return out
    let top: string[] = []
    try { top = readdirSync(root) } catch { return out }
    for (const entry of top) {
      if (entry.startsWith(".")) continue
      const full = join(root, entry)
      let st: ReturnType<typeof statSync>
      try { st = lstatSync(full) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (!st.isDirectory()) continue
      const lm = entry.match(LEGACY_RUN_RE)
      if (lm) {
        // Старый плоский формат: <host>_<date>_<time>.
        out.push({ host: lm[1], folder: entry, abs: full, date: lm[2], time: normTime(lm[3]) })
        continue
      }
      // Новый формат: <host>/<date>_<time>.
      let subs: string[] = []
      try { subs = readdirSync(full) } catch { continue }
      for (const sub of subs) {
        if (sub.startsWith(".")) continue
        const subFull = join(full, sub)
        let sst: ReturnType<typeof statSync>
        try { sst = lstatSync(subFull) } catch { continue }
        if (sst.isSymbolicLink()) continue
        if (!sst.isDirectory()) continue
        const sm = sub.match(RUN_STAMP_RE)
        if (!sm && !existsSync(join(subFull, OWNER_FILE))) continue
        out.push({ host: entry, folder: sub, abs: subFull, date: sm ? sm[1] : "", time: sm ? normTime(sm[2]) : "" })
      }
    }
    return out
  }

  // Авто-ретеншен: удаляет запуски старше N дней (настройка админки; 0 — выкл).
  // Используется таймером (раз в 6 часов) и вручную из админки.
  function runRetentionCleanup(daysOverride?: number): { removed: number; dirs: number; cutoff: string; days: number } {
    const days = daysOverride && daysOverride > 0 ? Math.floor(daysOverride) : adminSettings().resultsRetentionDays
    if (!days || days <= 0) return { removed: 0, dirs: 0, cutoff: "", days: 0 }
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
    let removed = 0, dirs = 0
    for (const run of listRuns()) {
      if (!run.date || run.date >= cutoff) continue
      try {
        removed += scanResults(run.abs).length
        rmSync(run.abs, { recursive: true, force: true })
        dirs++
        const parent = dirname(run.abs)
        if (basename(parent) !== basename(RESULTS_ROOT)) {
          try { if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true }) } catch {}
        }
      } catch {}
    }
    if (dirs) invalidateProjectsIndex()
    return { removed, dirs, cutoff, days }
  }

  // Новый формат: seo-results/<host>/<YYYY-MM-DD_HH-MM-SS>[_i]/ — проект
  // физически сгруппирован, запуски отсортированы по времени. Старый плоский
  // формат <host>_<дата>_<время> читается для обратной совместимости.
  // При коллизии (запуск в ту же секунду) добавляется счётчик.
  function makeRunDir(host: string, auth?: AuthInfo | null, meta?: { category?: string; task?: string }): string {
    const name = sanitizeHost(host || "project")
    const hostDir = join(RESULTS_ROOT, name)
    const day = todayStamp()
    const t = timeStamp()
    let runRoot = join(hostDir, `${day}_${t}`)
    let i = 1
    while (existsSync(runRoot)) runRoot = join(hostDir, `${day}_${t}_${i++}`)
    mkdirSync(runRoot, { recursive: true })
    // Владелец и манифест — на уровне запуска (в нём же подпапки по типу задания).
    writeOwner(runRoot, auth)
    writeRunMeta(runRoot, {
      host: name,
      category: meta?.category || "",
      task: meta?.task || "",
      owner: auth ? (hasGlobalAccess(auth) ? "admin" : auth.uid) : "",
      createdAt: new Date().toISOString(),
    })
    // outDir — подпапка по типу задания (если задана). Так готовые файлы разных
    // заданий не смешиваются. Для статей подпапку создаёт сам навык (articles/).
    const cat = String(meta?.category || "").trim()
    if (cat) {
      const outDir = join(runRoot, sanitizeHost(cat))
      mkdirSync(outDir, { recursive: true })
      return outDir
    }
    return runRoot
  }

  // Доступ сотрудника к файлу: файл должен лежать в папке результатов,
  // владельцем которой он является. Админ имеет доступ ко всему.
  function canAccessRel(rel: string, auth: AuthInfo | null): boolean {
    if (hasGlobalAccess(auth)) return true
    const abs = safePath(RESULTS_ROOT, rel || "")
    if (!abs) return false
    const root = realpathSync(RESULTS_ROOT)
    const rr = relative(root, abs)
    if (!rr || rr.startsWith("..") || rr.startsWith(".")) return false
    // Ищем ближайшую папку запуска вверх по дереву (в ней лежит .seo-owner):
    // поддерживает и старый (seo-results/<host>_<дата>_<время>/...), и новый
    // (seo-results/<host>/<дата>_<время>/...) форматы.
    let dir = abs
    try { if (!statSync(dir).isDirectory()) dir = dirname(dir) } catch { dir = dirname(dir) }
    while (dir && dir !== root) {
      if (existsSync(join(dir, OWNER_FILE))) return readOwner(dir) === auth.uid
      dir = dirname(dir)
    }
    return false
  }

  function deriveHostFromText(text: string): string | null {
    const m = String(text || "").match(/(?:https?:\/\/)?([a-z0-9][a-z0-9\-]*\.)+[a-z]{2,}/i)
    return m ? m[0].replace(/^https?:\/\//i, "") : null
  }

  // Ключ проекта для SMM-задач. Для групп важно различать не домен площадки
  // (vk.com/t.me/max.ru), а конкретную группу, поэтому берём хост + путь и
  // добавляем префикс площадки: vk.com/frontside -> smm_vk.com_frontside.
  function smmProjectKey(groups: string[]): string {
    const first = String(groups[0] || "").trim()
    let host = ""
    let path = ""
    try {
      const u = new URL(first.includes("://") ? first : "https://" + first)
      host = u.hostname.replace(/^www\./i, "")
      path = u.pathname.replace(/^\/+|\/+$/g, "")
    } catch {
      host = first
    }
    let key = host ? host + (path ? "_" + path : "") : "smm-groups"
    if (!/vk\.com|t\.me|telegram|max\.ru/i.test(key)) key = "smm_" + key
    return sanitizeHost(key) || "smm-groups"
  }

  // ---------------------------------------------------------------------------
  // Кэш-оглавление результатов (ускорение рендера вкладок).
  // «Мягко»: файловая система остаётся источником истины, манифест — лишь
  // ускоряющий кэш. Полный обход запускается только если изменилась структура
  // (подписи по mtime каталогов) или кэш отсутствует/повреждён.
  // ---------------------------------------------------------------------------
  const INDEX_TTL_MS = 2500
  let projectsIndexCache: { at: number; data: any[] } | null = null

  function indexPath(): string {
    return join(RESULTS_ROOT, ".index.json")
  }

  // Дешёвая подпись: обходим только КАТАЛОГИ (не файлы) и берём их mtime.
  // Добавление/удаление файла меняет mtime родительского каталога, поэтому
  // подпись ловит изменения структуры на любом уровне.
  function dirSignature(root: string): string {
    const parts: string[] = []
    function walk(d: string): void {
      let entries: string[]
      try { entries = readdirSync(d).sort() } catch { return }
      for (const n of entries) {
        if (n.startsWith(".")) continue
        const full = join(d, n)
        let st: ReturnType<typeof statSync>
        try { st = lstatSync(full) } catch { continue }
        if (st.isSymbolicLink()) continue
        if (!st.isDirectory()) continue
        parts.push(relative(root, full).split(sep).join("/") + ":" + Math.round(st.mtimeMs))
        walk(full)
      }
    }
    walk(root)
    return parts.join("|")
  }

  // Полный обход (все владельцы) — база для фильтрации по пользователю.
  function buildProjectsIndex(): any[] {
    const map: Record<string, { host: string; dates: any[] }> = {}
    for (const run of listRuns()) {
      const rawFiles = scanResults(run.abs)
      // Происхождение легаси-прогона: есть ли в нём артефакты аудита.
      const runIsAudit = rawFiles.some((f) =>
        /seo[-_ ]?аудит\.docx?$/i.test(f.name) || /^\d+\.\d+\.docx?$/i.test(f.name))
      const files = rawFiles.map((f) => ({
        name: f.name,
        // Keep the sub-path (e.g. articles/<slug>.docx) so the download link
        // resolves to the real file instead of 404-ing with a JSON body.
        path: relative(RESULTS_ROOT, join(run.abs, f.rel)).split(sep).join("/"),
        rel: f.rel.split(sep).join("/"),
        size: f.size,
        sizeHuman: formatSize(f.size),
        mtime: Math.round(f.mtime),
        ext: ext(f.name).toLowerCase(),
        category: classifyFile(f.name, ext(f.name).toLowerCase(), f.rel, runIsAudit),
      }))
      if (files.length === 0) continue
      if (!map[run.host]) map[run.host] = { host: run.host, dates: [] }
      map[run.host].dates.push({
        folder: run.folder, date: run.date, time: run.time,
        owner: readOwner(run.abs) || "",
        files,
      })
    }
    const out = Object.values(map)
    out.forEach((p) => p.dates.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)))
    out.sort((a, b) => (b.dates[0]?.date || "").localeCompare(a.dates[0]?.date || ""))
    return out
  }

  // Сброс кэша (в памяти и на диске). Вызывается после изменений результатов.
  function invalidateProjectsIndex(): void {
    projectsIndexCache = null
    try { const p = indexPath(); if (existsSync(p)) rmSync(p, { force: true }) } catch {}
  }

  // Возвращает оглавление: память (TTL) → диск (если подпись совпала) → полный обход.
  function getProjectsIndex(): any[] {
    if (projectsIndexCache && Date.now() - projectsIndexCache.at < INDEX_TTL_MS) {
      return projectsIndexCache.data
    }
    const root = RESULTS_ROOT
    const sig = dirSignature(root)
    try {
      const p = indexPath()
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, "utf8"))
        if (j && j.version === 1 && j.dirSig === sig && Array.isArray(j.projects)) {
          projectsIndexCache = { at: Date.now(), data: j.projects }
          return j.projects
        }
      }
    } catch (e) {
      log("index read failed, rebuilding: " + String(e))
    }
    const data = buildProjectsIndex()
    projectsIndexCache = { at: Date.now(), data }
    try {
      writeFileSync(indexPath(), JSON.stringify({ version: 1, dirSig: sig, builtAt: new Date().toISOString(), projects: data }))
    } catch (e) {
      log("index write failed: " + String(e))
    }
    return data
  }

  function scanProjects(filterHost?: string, auth?: AuthInfo | null): any[] {
    const out: any[] = []
    // Админ и IT-админ видят все проекты; сотрудник — только свои. При
    // выключенной авторизации фильтра нет.
    for (const p of getProjectsIndex()) {
      if (filterHost && p.host !== filterHost) continue
      const dates = p.dates
        .filter((d: any) => hasGlobalAccess(auth) || d.owner === auth?.uid)
        .map((d: any) => ({ folder: d.folder, date: d.date, time: d.time, files: d.files }))
      if (dates.length) out.push({ host: p.host, dates })
    }
    return out
  }

  let server: any
  // Фиксированный порт SEO-панели: по умолчанию 4180 (стабильный URL для коллег).
  // Переопределяется переменной SEO_UI_PORT. Если занят нашей же копией — переиспользуем.
  let chosenPort = parseInt(process.env.SEO_UI_PORT || String(DEFAULT_PORT), 10)
  if (!chosenPort || chosenPort < 1) chosenPort = DEFAULT_PORT
  let externalServer = false
  const fixedPort = chosenPort
  const lanIp = getLanIp()

  // Geo/AEO tracker (Next.js) — состояние объявлено заранее, чтобы HTTP-обработчик
  // ниже мог безопасно обращаться к нему (const/let в TDZ, поэтому до старта сервера).
  const TRACKER_DIR = join(projectDir, "geo-aeo-tracker")
  const TRACKER_PORT = parseInt(process.env.OPENCODE_GEO_TRACKER_PORT || "3000", 10)
  let trackerProc: any = null
  let trackerState: "off" | "starting" | "build" | "ready" | "error" = "off"
  let trackerMessage = ""

  // Состояние фонового создания архива (админка → «Бэкапы»).
  let backupProc: any = null
  let backupState: { running: boolean; message: string; startedAt?: number; archive?: string } = { running: false, message: "" }

  const requestHandler = async (req: Request): Promise<Response> => {
      const url = new URL(req.url)
      const clientIp = clientIpOf(req)
      // Текущий пользователь панели. Защищённые маршруты доходят сюда только
      // после проверки авторизации, поэтому здесь getAuth уже не null.
      const currentAuth: AuthInfo = getAuth(req) || { role: "admin", uid: "admin" }
      // Задача с привязкой к владельцу — для раздельного показа списка задач.
      const mkTask = (tool: string, label: string): TaskState => {
        const t = newTask(tool, label)
        t.owner = hasGlobalAccess(currentAuth) ? "admin" : currentAuth.uid
        return t
      }

      // ---------- CSRF: защита состояние-меняющих запросов ----------
      // Браузер на кросс-сайтовый POST всегда шлёт Origin. Если он пришёл и не
      // совпадает с нашим хостом — блокируем. Не-браузерные клиенты (curl и т.п.)
      // Origin не шлют, для них проверка no-op.
      if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
        const origin = req.headers.get("origin")
        if (origin && origin !== "null") {
          let ok = false
          try { ok = new URL(origin).host === (req.headers.get("host") || "") } catch { ok = false }
          if (!ok) {
            auditLog(`CSRF_BLOCK ip=${clientIp || "?"} ${req.method} ${url.pathname} origin=${origin}`)
            if (url.pathname.startsWith("/api/")) {
              return Response.json({ ok: false, error: "Cross-origin request blocked" }, { status: 403 })
            }
            return new Response("Forbidden", { status: 403 })
          }
        }
      }

      // ---------- Allowlist по IP ----------
      // /api/health оставляем доступным для внутреннего пробинга панели.
      if (url.pathname !== "/api/health" && !ipAllowed(clientIp)) {
        auditLog(`BLOCKED ip=${clientIp || "?"} ${req.method} ${url.pathname}`)
        return new Response("Forbidden", { status: 403 })
      }

      // ---------- Авторизация ----------
      if (authEnabled() && url.pathname !== "/login" && url.pathname !== "/api/health" && url.pathname !== "/img/bg.png") {
        if (!isAuthed(req)) {
          if (url.pathname.startsWith("/api/")) {
            return Response.json({ ok: false, error: "unauthorized" }, { status: 401 })
          }
          return new Response(buildLoginHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } })
        }
      }

      // ---------- Журнал аудита запусков ----------
      // Фиксируем авторизованные запуски задач с указанием IP (кто и когда).
      if (req.method === "POST" && (url.pathname.startsWith("/run-") || url.pathname === "/api/revise")) {
        auditLog(`RUN ip=${clientIp || "?"} ${url.pathname}`)
      }

      if (req.method === "POST" && url.pathname === "/login") {
        if (loginBlocked(clientIp)) {
          auditLog(`LOGIN_BLOCKED ip=${clientIp || "?"} (слишком много попыток)`)
          return new Response(buildLoginHtml("Слишком много попыток входа. Попробуйте позже."), {
            status: 429,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          })
        }
        let pwd = ""
        let uname = ""
        try {
          const ctype = req.headers.get("content-type") || ""
          if (ctype.includes("application/json")) {
            const j: any = await req.json().catch(() => null)
            pwd = j ? String(j.password || "") : ""
            uname = j ? String(j.username || "") : ""
          } else {
            const form = await req.formData().catch(() => null)
            pwd = form ? String(form.get("password") || "") : ""
            uname = form ? String(form.get("username") || "") : ""
          }
        } catch {}

        let auth: AuthInfo | null = null
        // IT-доступ включён только явно заданным секретом окружения.
        if (uname && sanitizeOwnerName(uname) === sanitizeOwnerName(IT_ADMIN_NAME) && verifyItLogin(pwd)) {
          auth = { role: "it", uid: IT_ADMIN_NAME }
        } else {
          // 2) Именованный пользователь из админки (имя + свой пароль).
          const named = uname ? verifyAdminUser(uname, pwd) : null
          if (named) {
            auth = { role: named.role, uid: named.name }
          } else if (ADMIN_PASSWORD && findAdminUser("admin")?.active && constantTimeEqual(pwd, ADMIN_PASSWORD)) {
            // 3) Legacy-админ: пароль без имени (страховка владельца).
            auth = { role: "admin", uid: "admin" }
          }
        }

        if (auth) {
          const signingSecret = getAuthSecret()
          const credential = authCredential(auth)
          if (!credential) return Response.json({ ok: false, error: "Учётная запись отключена" }, { status: 403 })
          loginFails.delete(clientIp)
          recordAdminLogin(auth.uid, clientIp || "")
          auditLog(`LOGIN_OK ip=${clientIp || "?"} role=${auth.role} user=${auth.uid}`)
          return new Response(null, {
            status: 303,
            headers: {
              "Location": "/",
              "Set-Cookie": `${AUTH_COOKIE}=${createAuthToken(auth, signingSecret, Date.now(), credentialVersion(signingSecret, credential))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
            },
          })
        }
        loginFail(clientIp)
        auditLog(`LOGIN_FAIL ip=${clientIp || "?"}`)
        return new Response(buildLoginHtml("Неверный пароль."), {
          status: 401,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        })
      }

      if (req.method === "GET" && url.pathname === "/logout") {
        return new Response(null, {
          status: 303,
          headers: {
            "Location": "/login",
            "Set-Cookie": `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
          },
        })
      }

      if (req.method === "GET" && url.pathname === "/") {
        return new Response(buildUiHtml(chosenPort, lanIp, currentAuth), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        })
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        return Response.json({ ok: true, app: UI_APP_MARKER, port: chosenPort, pid: process.pid })
      }
      if (req.method === "GET" && url.pathname === "/img/bg.png") {
        const bgPath = join(projectDir, ".opencode", "plugin", "bg.png")
        try {
          if (!existsSync(bgPath)) return new Response("Not Found", { status: 404 })
          return new Response(readFileSync(bgPath), {
            headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" },
          })
        } catch (e) {
          return new Response(String(e), { status: 500 })
        }
      }

      // ---------- Админ-панель (роли «администратор» и «IT-администратор») ----------
      const isAdmin = hasGlobalAccess(currentAuth)
      const isIt = currentAuth.role === "it"
      const adminDenied = () => Response.json({ ok: false, error: "Доступ только для администратора" }, { status: 403 })

      // ---------- Аналитика, история, проблемы, генераторы ----------
      if (req.method === "GET" && (url.pathname === "/insights" || url.pathname === "/generators")) {
        if (!isAdmin) return new Response("Доступ только для администратора", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } })
        return new Response(url.pathname === "/insights" ? renderInsightsPage() : renderGeneratorsPage(), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        })
      }

      if (url.pathname.startsWith("/api/insights/") || url.pathname === "/api/generate" || url.pathname.startsWith("/api/presets")) {
        if (!isAdmin) return adminDenied()
        try {
          const settings = readSettings(RESULTS_ROOT)

          if (req.method === "GET" && url.pathname === "/api/insights/overview") {
            const runs = readRuns(RESULTS_ROOT).runs
            const issues = readIssues(RESULTS_ROOT)
            const byHost = new Map<string, RunRecord[]>()
            for (const r of runs) {
              const list = byHost.get(r.host)
              if (list) list.push(r); else byHost.set(r.host, [r])
            }
            const hosts = [...byHost].map(([host, list]) => {
              const last = list[list.length - 1]
              const prev = list.length > 1 ? list[list.length - 2] : null
              const open = Object.values(issues.hosts[host]?.issues || {})
                .filter((i) => i.status === "open" || i.status === "in_progress").length
              const delta = prev && last.score !== null && prev.score !== null ? last.score - prev.score : null
              return { host, runs: list.length, lastAt: last.at, score: last.score, gate: last.gate, open, delta }
            }).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
            return Response.json({ ok: true, hosts })
          }

          if (req.method === "GET" && url.pathname === "/api/insights/history") {
            const host = url.searchParams.get("host") || ""
            const all = readRuns(RESULTS_ROOT).runs
            return Response.json({ ok: true, runs: host ? all.filter((r) => r.host === host) : all })
          }

          if (req.method === "GET" && url.pathname === "/api/insights/report") {
            const id = url.searchParams.get("run") || ""
            const runs = readRuns(RESULTS_ROOT).runs
            const idx = runs.findIndex((r) => r.id === id)
            if (idx < 0) return Response.json({ ok: false, error: "Прогон не найден" })
            const run = runs[idx]
            const report = readAuditReport(run.dir)
            const prev = runs.slice(0, idx).filter((r) => r.host === run.host).slice(-1)[0] || null
            const delta = report ? diffReports(prev ? readAuditReport(prev.dir) : null, report) : null
            return Response.json({ ok: true, run, report, delta })
          }

          if (req.method === "GET" && url.pathname === "/api/insights/issues") {
            const host = url.searchParams.get("host") || ""
            const status = url.searchParams.get("status") || ""
            const store = readIssues(RESULTS_ROOT)
            const list: any[] = []
            for (const [h, bucket] of Object.entries(store.hosts)) {
              if (host && h !== host) continue
              for (const rec of Object.values(bucket.issues || {})) {
                if (status && rec.status !== status) continue
                list.push({ ...rec, host: h })
              }
            }
            list.sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
            return Response.json({ ok: true, issues: list })
          }

          if (req.method === "POST" && url.pathname === "/api/insights/issues/status") {
            const body = await readBody(req)
            const store = readIssues(RESULTS_ROOT)
            const status = ["open", "in_progress", "fixed", "ignored"].includes(String(body.status)) ? body.status : "open"
            if (!setIssueStatus(store, String(body.host || ""), String(body.id || ""), status, body.note ? String(body.note) : undefined)) {
              return Response.json({ ok: false, error: "Проблема не найдена" })
            }
            writeIssues(RESULTS_ROOT, store)
            return Response.json({ ok: true })
          }

          if (req.method === "GET" && url.pathname === "/api/insights/settings") {
            return Response.json({ ok: true, settings })
          }

          if (req.method === "POST" && url.pathname === "/api/insights/telegram") {
            const body = await readBody(req)
            const next = saveSettings(RESULTS_ROOT, { telegram: { token: String(body.token || "").trim(), chatId: String(body.chatId || "").trim() } })
            return Response.json({ ok: true, telegram: next.telegram })
          }

          if (req.method === "POST" && url.pathname === "/api/insights/integrations") {
            const body = await readBody(req)
            const pick = (k: string) => String(body[k] || "").trim()
            const next = saveSettings(RESULTS_ROOT, { integrations: {
              psiKey: pick("psiKey"), gscToken: pick("gscToken"), webmasterToken: pick("webmasterToken"),
              metrikaToken: pick("metrikaToken"), metrikaCounter: pick("metrikaCounter"),
            } })
            return Response.json({ ok: true, integrations: next.integrations })
          }

          if (req.method === "POST" && url.pathname === "/api/insights/integrations/test") {
            const body = await readBody(req)
            const ints = settings.integrations
            const kind = String(body.kind || "")
            const day = 86_400_000
            const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
            if (kind === "psi") {
              return Response.json({ ok: true, result: await psiCheck({ url: String(body.url || "https://example.com/"), apiKey: ints.psiKey, strategy: "mobile" }) })
            }
            if (kind === "gsc") return Response.json({ ok: true, result: await gscSites({ token: ints.gscToken }) })
            if (kind === "webmaster") return Response.json({ ok: true, result: await webmasterHosts({ token: ints.webmasterToken }) })
            if (kind === "metrika") {
              const result = await metrikaSummary({ token: ints.metrikaToken, counterId: ints.metrikaCounter, startDate: iso(Date.now() - 30 * day), endDate: iso(Date.now()) })
              return Response.json({ ok: true, result })
            }
            if (kind === "wordstat") {
              const result = await wordstatFrequency({ apiKey: ints.wordstatKey, folderId: ints.wordstatFolderId, phrases: [String(body.phrase || "купить котёл")] })
              return Response.json({ ok: result.ok, result })
            }
            if (kind === "metrika-sources") {
              const result = await metrikaTrafficSources({ token: ints.metrikaToken, counterId: ints.metrikaCounter, startDate: iso(Date.now() - 30 * day), endDate: iso(Date.now()) })
              return Response.json({ ok: true, result })
            }
            if (kind === "metrika-goals") {
              const result = await metrikaGoals({ token: ints.metrikaToken, counterId: ints.metrikaCounter, startDate: iso(Date.now() - 30 * day), endDate: iso(Date.now()) })
              return Response.json({ ok: true, result })
            }
            if (kind === "metrika-compare") {
              const result = await metrikaComparePeriods({
                token: ints.metrikaToken, counterId: ints.metrikaCounter,
                date1From: iso(Date.now() - 60 * day), date1To: iso(Date.now() - 30 * day),
                date2From: iso(Date.now() - 30 * day), date2To: iso(Date.now()),
              })
              return Response.json({ ok: true, result })
            }
            return Response.json({ ok: false, error: "Неизвестная интеграция" })
          }

          if (req.method === "GET" && url.pathname === "/api/insights/positions") {
            const host = String(url.searchParams.get("host") || "")
            const date = String(url.searchParams.get("date") || "")
            const positions = host ? lastPositions(RESULTS_ROOT, host, date || undefined) : readPositions(RESULTS_ROOT).positions
            return Response.json({ ok: true, positions: host ? positions : positions.slice(0, 100) })
          }

          if (req.method === "POST" && url.pathname === "/api/insights/positions") {
            const body = await readBody(req)
            const positions = Array.isArray(body.positions) ? body.positions : []
            if (!positions.length) return Response.json({ ok: false, error: "Нет позиций для сохранения" })
            const store = appendPositions(RESULTS_ROOT, positions)
            return Response.json({ ok: true, count: store.positions.length })
          }

          if (req.method === "GET" && url.pathname === "/api/insights/positions/delta") {
            const host = String(url.searchParams.get("host") || "")
            const dateFrom = String(url.searchParams.get("dateFrom") || "")
            const dateTo = String(url.searchParams.get("dateTo") || "")
            if (!host || !dateFrom || !dateTo) return Response.json({ ok: false, error: "Укажите host, dateFrom, dateTo" })
            const delta = positionsDelta(RESULTS_ROOT, host, dateFrom, dateTo)
            return Response.json({ ok: true, delta })
          }

          if (req.method === "POST" && url.pathname === "/api/insights/schedules") {
            const body = await readBody(req)
            const site = String(body.site || "").trim()
            const host = hostFromUrl(site) || deriveHostFromText(site) || ""
            if (!host) return Response.json({ ok: false, error: "Укажите URL сайта" })
            const preset = settings.presets.find((p) => p.name === String(body.preset || ""))
            const last = readRuns(RESULTS_ROOT).runs.filter((r) => r.host === host).slice(-1)[0]
            const points = preset ? preset.points : (last ? pointRefs(last.points) : [])
            if (!points.length) return Response.json({ ok: false, error: "Нет пунктов: выберите пресет или запустите аудит этого сайта вручную" })
            const schedules = settings.schedules.filter((s) => s.site !== site)
            schedules.push({
              site, host, points,
              everyDays: Math.max(1, Math.min(90, Number(body.everyDays) || 7)),
              hour: Math.max(0, Math.min(23, Number(body.hour) || 9)),
              enabled: true,
              depthContent: Number(body.depthContent) || undefined,
              depthSpeed: Number(body.depthSpeed) || undefined,
            })
            return Response.json({ ok: true, schedules: saveSettings(RESULTS_ROOT, { schedules }).schedules })
          }

          if (req.method === "POST" && url.pathname === "/api/insights/schedules/toggle") {
            const body = await readBody(req)
            const site = String(body.site || "")
            const schedules = settings.schedules.map((s) => s.site === site ? { ...s, enabled: !s.enabled } : s)
            return Response.json({ ok: true, schedules: saveSettings(RESULTS_ROOT, { schedules }).schedules })
          }

          if (req.method === "POST" && url.pathname === "/api/insights/schedules/delete") {
            const body = await readBody(req)
            const schedules = settings.schedules.filter((s) => s.site !== String(body.site || ""))
            return Response.json({ ok: true, schedules: saveSettings(RESULTS_ROOT, { schedules }).schedules })
          }

          if (req.method === "POST" && url.pathname === "/api/insights/repeat") {
            const body = await readBody(req)
            const run = readRuns(RESULTS_ROOT).runs.find((r) => r.id === String(body.runId || ""))
            if (!run) return Response.json({ ok: false, error: "Прогон не найден" })
            const points = pointRefs(run.points)
            if (!points.length) return Response.json({ ok: false, error: "В прогоне нет известных пунктов" })
            let semcoreMsg = run.semcoreMsg || ""
            let semcorePath = run.semcorePath
            if (semcorePath && !existsSync(semcorePath)) {
              semcorePath = undefined
              semcoreMsg = ""
            }
            return Response.json(enqueueAudit({ site: run.site, points, owner: "admin", auth: currentAuth,
              depthContent: run.depthContent ?? 50, depthSpeed: run.depthSpeed ?? 10,
              semcoreMsg, semcorePath }))
          }

          if (url.pathname === "/api/presets") {
            if (req.method === "GET") return Response.json({ ok: true, presets: settings.presets })
            const body = await readBody(req)
            const name = String(body.name || "").trim().slice(0, 80)
            const points = (Array.isArray(body.points) ? body.points : [])
              .map((p: any) => ({ point: String(p?.point || "").trim(), skill: String(p?.skill || "").trim() }))
              .filter((p: any) => p.point && p.skill)
            if (!name || !points.length) return Response.json({ ok: false, error: "Нужны имя пресета и хотя бы один пункт" })
            const presets = settings.presets.filter((p) => p.name !== name)
            presets.push({ name, points })
            return Response.json({ ok: true, presets: saveSettings(RESULTS_ROOT, { presets }).presets })
          }

          if (req.method === "POST" && url.pathname === "/api/generate") {
            const body = await readBody(req)
            const kind = String(body.kind || "")
            if (kind === "robots") {
              return Response.json({ ok: true, filename: "robots.txt", content: buildRobots({
                sitemaps: Array.isArray(body.sitemaps) ? body.sitemaps : [],
                disallow: Array.isArray(body.disallow) ? body.disallow : [],
                allow: Array.isArray(body.allow) ? body.allow : [],
                cleanParams: body.cleanParams !== false,
              }) })
            }
            if (kind === "sitemap") {
              return Response.json({ ok: true, filename: "sitemap.xml", content: buildSitemap(Array.isArray(body.urls) ? body.urls : [], {
                lastmod: String(body.lastmod || ""), changefreq: String(body.changefreq || ""), priority: String(body.priority || ""),
              }) })
            }
            if (kind === "sitemap-from-csv") {
              return Response.json({ ok: true, urls: urlsFromCsv(String(body.csv || "")) })
            }
            if (kind === "jsonld-template") {
              return Response.json({ ok: true, template: jsonLdTemplate(String(body.type || "")) })
            }
            if (kind === "jsonld") {
              const r = buildJsonLd(String(body.type || ""), body.data && typeof body.data === "object" ? body.data : {})
              return Response.json({ ok: r.ok, errors: r.errors, script: r.script, json: r.json })
            }
            return Response.json({ ok: false, error: "Неизвестный тип файла" })
          }

          return Response.json({ ok: false, error: "Не найдено" }, { status: 404 })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) }, { status: 500 })
        }
      }


      if (req.method === "GET" && url.pathname === "/admin") {
        if (!isAdmin) {
          return new Response(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Доступ запрещён</title></head><body style="font-family:sans-serif;padding:40px;background:#0f1117;color:#e6e9f0"><h1>403</h1><p>Доступ к админ-панели только для администратора.</p><p><a href="/" style="color:#4f8cff">← Вернуться в панель</a></p></body></html>`, { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } })
        }
        return new Response(buildAdminHtml(chosenPort, lanIp, currentAuth), { headers: { "Content-Type": "text/html; charset=utf-8" } })
      }

      if (url.pathname.startsWith("/api/admin/")) {
        if (!isAdmin) return adminDenied()
        try {
          const sub = url.pathname.slice("/api/admin/".length)

          if (req.method === "GET" && sub === "overview") {
            const users = readAdminStore().users
            const settings = adminSettings()
            const resultsSize = dirSizeBytes(RESULTS_ROOT)
            const archivesSize = dirSizeBytes(join(projectDir, "seo-center-archives"))
            const queuedAudits = [...auditJobs.values()].filter((j) => j.status === "queued").length
            const mm = currentMainModel()
            return Response.json({ ok: true, stats: {
              users: users.length, activeUsers: users.filter((u) => u.active).length,
              runningTasks: runningTasksOrdered().length, queuedAudits,
              resultsSize, resultsSizeHuman: formatSize(resultsSize),
              archivesSize, archivesSizeHuman: formatSize(archivesSize),
              uptimeHuman: fmtUptime(process.uptime()), port: chosenPort, pid: process.pid,
              modelMain: mm.providerID + "/" + mm.modelID, settings,
            } })
          }

          if (req.method === "GET" && sub === "users") {
            return Response.json({ ok: true, users: readAdminStore().users.map(publicAdminUser) })
          }

          if (req.method === "POST" && sub === "users/save") {
            const body = await readBody(req)
            const u = upsertAdminUser({
              name: String(body.name || ""),
              role: body.role === "admin" ? "admin" : "user",
              password: body.password ? String(body.password) : undefined,
              active: body.active !== false,
              originalName: body.originalName ? String(body.originalName) : undefined,
            })
            auditLog(`ADMIN_USER_SAVE ip=${clientIp || "?"} by=${currentAuth.uid} user=${u.name} role=${u.role}`)
            return Response.json({ ok: true, user: publicAdminUser(u) })
          }

          if (req.method === "POST" && sub === "users/delete") {
            const body = await readBody(req)
            const r = removeAdminUser(String(body.name || ""))
            if (!r.ok) return Response.json({ ok: false, error: r.error })
            auditLog(`ADMIN_USER_DELETE ip=${clientIp || "?"} by=${currentAuth.uid} user=${String(body.name || "")}`)
            return Response.json({ ok: true })
          }

          if (req.method === "POST" && sub === "settings") {
            const body = await readBody(req)
            const saved = saveAdminSettings({
              auditMaxConcurrent: body.auditMaxConcurrent,
              auditAvgMinutes: body.auditAvgMinutes,
              resultsRetentionDays: body.resultsRetentionDays,
            })
            auditLog(`ADMIN_SETTINGS ip=${clientIp || "?"} by=${currentAuth.uid} concurrent=${saved.auditMaxConcurrent} retention=${saved.resultsRetentionDays}`)
            return Response.json({ ok: true, settings: saved })
          }

          if (req.method === "GET" && sub === "jobs") {
            const running = runningTasksOrdered().map((t) => ({ id: t.id, tool: t.tool, label: t.label, owner: t.owner || "", startedAt: t.startedAt }))
            const queuedSorted = [...auditJobs.values()].filter((j) => j.status === "queued").sort((a, b) => a.enqueuedAt - b.enqueuedAt)
            const queued = queuedSorted.map((j, i) => ({ id: j.id, site: j.site, owner: j.owner, eta: fmtEta(auditEtaMinutes(i + 1)) }))
            const history = readAdminStore().history.slice(0, 200)
            return Response.json({ ok: true, running, queued, history, max: auditMaxConcurrent() })
          }

          if (req.method === "POST" && sub === "jobs/cancel") {
            const body = await readBody(req)
            const jobId = String(body.jobId || "").trim()
            const taskId = String(body.taskId || "").trim()
            if (jobId) {
              const job = auditJobs.get(jobId)
              if (!job) return Response.json({ ok: false, error: "Задание не найдено" })
              if (job.status !== "queued") return Response.json({ ok: false, error: "Аудит уже выполняется" })
              auditJobs.delete(jobId)
              scheduleQueueSave()
              return Response.json({ ok: true })
            }
            const task = taskId ? tasksStore.get(taskId) : runningTasksOrdered()[0]
            if (!task) return Response.json({ ok: false, error: "Задача не найдена" })
            clearIdleTimer(task.id)
            updateTask(task.id, { status: "cancelled", message: "Задание отменено администратором" })
            invalidateProjectsIndex()
            if (task.auditJobId) finishAuditJob(task.auditJobId)
            const sessionID = task.sessionID || taskSessions.get(task.id) || activeSessionID || (await sessionForProject((task.owner && task.owner !== "admin" ? task.owner + "::" : "") + (task.host || "project")))
            try { await client.session.abort({ path: { id: sessionID } }) } catch (e) { log("admin abort failed: " + String(e)) }
            auditLog(`ADMIN_CANCEL ip=${clientIp || "?"} by=${currentAuth.uid} task=${task.id}`)
            return Response.json({ ok: true, taskId: task.id })
          }

          if (req.method === "GET" && sub === "projects") {
            const idx = getProjectsIndex()
            const projects = idx.map((p: any) => {
              const files = p.dates.reduce((n: number, d: any) => n + (d.files ? d.files.length : 0), 0)
              const size = p.dates.reduce((n: number, d: any) => n + (d.files ? d.files.reduce((m: number, f: any) => m + (f.size || 0), 0) : 0), 0)
              const owners = Array.from(new Set(p.dates.map((d: any) => d.owner).filter(Boolean)))
              const last = p.dates[0] ? (p.dates[0].date + " " + p.dates[0].time) : ""
              const fileList: any[] = []
              for (const d of p.dates) {
                for (const f of (d.files || [])) {
                  fileList.push({ name: f.name, path: f.path, size: f.size, sizeHuman: f.sizeHuman, date: d.date, time: d.time, owner: d.owner || "" })
                }
              }
              fileList.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))
              return { host: p.host, runs: p.dates.length, files, size, owners, last, fileList }
            })
            return Response.json({ ok: true, projects })
          }

          if (req.method === "POST" && sub === "projects/delete") {
            const body = await readBody(req)
            const host = String(body.host || "").trim()
            const prefix = host ? sanitizeHost(host).toLowerCase() : ""
            if (!prefix) return Response.json({ ok: false, error: "Не указан проект" })
            let removed = 0, dirs = 0
            for (const run of listRuns()) {
              if (sanitizeHost(run.host).toLowerCase() !== prefix) continue
              try {
                removed += scanResults(run.abs).length
                rmSync(run.abs, { recursive: true, force: true })
                dirs++
                const parent = dirname(run.abs)
                if (basename(parent) !== basename(RESULTS_ROOT)) {
                  try { if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true }) } catch {}
                }
              } catch {}
            }
            invalidateProjectsIndex()
            auditLog(`ADMIN_PROJECT_DELETE ip=${clientIp || "?"} by=${currentAuth.uid} host=${host} dirs=${dirs}`)
            return Response.json({ ok: true, removed, dirs })
          }

          if (req.method === "POST" && sub === "projects/cleanup") {
            const body = await readBody(req)
            const days = Math.max(1, parseInt(String(body.olderThanDays || "90"), 10) || 90)
            const r = runRetentionCleanup(days)
            auditLog(`ADMIN_CLEANUP ip=${clientIp || "?"} by=${currentAuth.uid} days=${days} dirs=${r.dirs}`)
            return Response.json({ ok: true, removed: r.removed, dirs: r.dirs, cutoff: r.cutoff })
          }

          if (req.method === "POST" && sub === "retention-run") {
            const r = runRetentionCleanup()
            auditLog(`ADMIN_RETENTION ip=${clientIp || "?"} by=${currentAuth.uid} days=${r.days} dirs=${r.dirs}`)
            return Response.json({ ok: true, ...r })
          }

          if (sub === "logs" || sub === "logs-clear" || sub === "backups" || sub === "backup" || sub === "download-archive" || sub === "restart" || sub === "restart-status") {
            if (!isIt) return Response.json({ ok: false, error: "Доступно только IT-администратору" }, { status: 403 })
          }

          if (req.method === "POST" && sub === "logs-clear") {
            const removed = clearAuditLog()
            auditLog(`ADMIN_LOGS_CLEAR ip=${clientIp || "?"} by=${currentAuth.uid} files=${removed}`)
            return Response.json({ ok: true, removed })
          }

          if (req.method === "GET" && sub === "restart-status") {
            return Response.json({ ok: true, ...pluginRestartStatus() })
          }

          if (req.method === "POST" && sub === "restart") {
            auditLog(`ADMIN_RESTART ip=${clientIp || "?"} by=${currentAuth.uid}`)
            // Перезапуск выполняем отдельным transient-юнитом (вне нашего cgroup),
            // иначе мы убьём процесс, который ещё должен отдать этот ответ.
            try {
              // Перезапускаем ИМЕННО свой инстанс: у теста свой юнит (SEO_UNIT_NAME).
              const targetUnit = (process.env.SEO_UNIT_NAME || "opencode-seo.service").trim() || "opencode-seo.service"
              const unit = "seo-center-restart-" + Date.now()
              const p = spawn("systemd-run", ["--user", "--collect", "--unit", unit, "bash", "-lc", "sleep 1; systemctl --user restart " + targetUnit], { detached: true, stdio: "ignore", env: process.env })
              p.unref()
              return Response.json({ ok: true, scheduled: true, unit: targetUnit })
            } catch (e) {
              return Response.json({ ok: false, error: String(e) })
            }
          }

          if (req.method === "GET" && sub === "logs") {
            const type = url.searchParams.get("type") || "audit"
            const lines = Math.min(2000, Math.max(20, parseInt(url.searchParams.get("lines") || "300", 10) || 300))
            let text = ""
            if (type === "service") {
              text = await runCmdCapture("journalctl", ["--user", "-u", "opencode-seo.service", "-n", String(lines), "--no-pager"], 9000)
            } else {
              text = tailLines(AUDIT_LOG, lines)
            }
            if (url.searchParams.get("download") === "1") {
              return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent("seo-center-" + type + ".log") } })
            }
            return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } })
          }

          if (req.method === "GET" && sub === "backups") {
            const archivesDir = join(projectDir, "seo-center-archives")
            return Response.json({ ok: true, archives: listArchives(), disk: {
              results: dirSizeBytes(RESULTS_ROOT), archives: dirSizeBytes(archivesDir), freeHuman: freeDiskHuman(),
            }, running: backupState.running, message: backupState.message })
          }

          if (req.method === "POST" && sub === "backup") {
            if (backupState.running) return Response.json({ ok: false, error: "Архив уже создаётся" })
            const script = join(projectDir, ".opencode", "skills", "seo-center-backup", "scripts", "backup.sh")
            if (!existsSync(script)) return Response.json({ ok: false, error: "Скрипт бэкапа не найден: " + script })
            backupState = { running: true, message: "запуск…", startedAt: Date.now() }
            try {
              const p = spawn("bash", [script, "--project", projectDir], { cwd: projectDir, env: process.env })
              let buf = ""
              p.stdout?.on("data", (d: any) => { const s = d.toString(); buf += s; const last = s.trim().split("\n").filter(Boolean).slice(-1)[0]; if (last) backupState.message = last })
              p.stderr?.on("data", (d: any) => { buf += d.toString() })
              p.on("close", (code: number) => {
                backupState.running = false
                const m = buf.match(/ARCHIVE_PATH=(.+)/)
                backupState.archive = m ? m[1].trim() : ""
                backupState.message = code === 0 ? ("готово: " + basename(backupState.archive || "архив")) : ("ошибка (код " + code + ")")
                try { mkdirSync(join(projectDir, "seo-center-archives"), { recursive: true }); appendFileSync(join(projectDir, "seo-center-archives", "backup.log"), "\n=== " + new Date().toISOString() + " ===\n" + buf) } catch {}
              })
              p.on("error", (e: any) => { backupState.running = false; backupState.message = "ошибка запуска: " + String(e) })
              backupProc = p
            } catch (e) { backupState.running = false; backupState.message = String(e); return Response.json({ ok: false, error: String(e) }) }
            auditLog(`ADMIN_BACKUP ip=${clientIp || "?"} by=${currentAuth.uid}`)
            return Response.json({ ok: true })
          }

          if (req.method === "GET" && sub === "download-archive") {
            const name = basename(url.searchParams.get("name") || "")
            const abs = join(projectDir, "seo-center-archives", name)
            if (!name || !existsSync(abs) || !statSync(abs).isFile()) return Response.json({ ok: false, error: "Архив не найден" }, { status: 404 })
            return new Response(readFileSync(abs), { headers: {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(name),
            } })
          }

          return Response.json({ ok: false, error: "Неизвестный админ-маршрут: " + sub }, { status: 404 })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "GET" && url.pathname === "/api/projects") {
        try {
          const filterHost = url.searchParams.get("host") || undefined
          const projects = scanProjects(filterHost, currentAuth)
          let total = 0
          projects.forEach((p) => p.dates.forEach((d) => (total += d.files.length)))
          return Response.json({ ok: true, projects, total })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "GET" && url.pathname === "/api/tasks") {
        try {
          const tasks = [...tasksStore.values()]
            .filter((t) => hasGlobalAccess(currentAuth) || t.owner === currentAuth.uid)
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, 20)
          return Response.json({ ok: true, tasks })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "GET" && url.pathname === "/api/tracker") {
        return Response.json(await trackerSnapshot())
      }

      if (req.method === "POST" && url.pathname === "/api/tracker/restart") {
        try {
          // Трекер может обслуживаться внешней systemd-службой (geo-tracker.service),
          // тогда перезапускаем именно её, а не поднимаем второй процесс внутри плагина.
          if (await hasExternalTrackerUnit()) {
            trackerState = "starting"
            trackerMessage = "перезапуск службы geo-tracker…"
            const ok = await new Promise<boolean>((resolve) => {
              try {
                const p = spawn("systemctl", ["--user", "restart", "geo-tracker.service"], { stdio: "ignore" })
                p.on("close", (code) => resolve(code === 0))
                p.on("error", () => resolve(false))
              } catch { resolve(false) }
            })
            ;(async () => {
              if (!ok) return
              for (let i = 0; i < 30; i++) {
                await new Promise((r) => setTimeout(r, 1000))
                if (await probeTrackerPort()) {
                  trackerState = "ready"
                  trackerMessage = "служба перезапущена"
                  return
                }
              }
              trackerState = "error"
              trackerMessage = "служба не поднялась после перезапуска"
            })()
            return Response.json({ ok, external: true })
          }
          if (process.env.OPENCODE_GEO_TRACKER === "0") {
            return Response.json({
              ok: false,
              error: "Трекер отключён (OPENCODE_GEO_TRACKER=0) и внешняя служба geo-tracker не найдена",
            })
          }
          const had = !!trackerProc
          killTracker()
          trackerState = "starting"
          trackerMessage = "перезапуск…"
          // Если процесс был — даём ему время освободить порт, чтобы не принять
          // свой же умирающий сервер за «уже запущенный».
          ;(async () => {
            if (had) await new Promise((r) => setTimeout(r, 2000))
            startTracker().catch((e) => log("tracker restart failed: " + String(e)))
          })()
          return Response.json({ ok: true })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "POST" && url.pathname === "/api/tasks/cancel") {
        try {
          const body = await readBody(req)
          const id = String(body.id || "").trim()
          const own = hasGlobalAccess(currentAuth)
            ? runningTasksOrdered()
            : runningTasksOrdered().filter((t: TaskState) => t.owner === currentAuth.uid)
          const task = id ? tasksStore.get(id) : own[0]
          if (!task) return Response.json({ ok: true, note: "нет задачи" })
          if (!hasGlobalAccess(currentAuth) && task.owner !== currentAuth.uid) {
            return Response.json({ ok: false, error: "Это задание другого пользователя" }, { status: 403 })
          }
          clearIdleTimer(task.id)
          updateTask(task.id, { status: "cancelled", message: "Задание отменено" })
          invalidateProjectsIndex()
          if (task.auditJobId) finishAuditJob(task.auditJobId)
          const sessionID =
            task.sessionID || taskSessions.get(task.id) || activeSessionID || (await sessionForProject((task.owner && task.owner !== "admin" ? task.owner + "::" : "") + (task.host || "project")))
          try {
            await client.session.abort({ path: { id: sessionID } })
          } catch (e) {
            log("abort failed: " + String(e))
          }
          log("cancel requested for task " + task.id + " session " + sessionID)
          return Response.json({ ok: true, taskId: task.id })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "POST" && url.pathname === "/api/delete") {
        try {
          const body = await readBody(req)
          const rel = String(body.file || "").trim()
          if (!rel) return Response.json({ ok: false, error: "Не указан файл" })
          const abs = safePath(RESULTS_ROOT, rel)
          if (!abs || !existsSync(abs) || !statSync(abs).isFile()) {
            return Response.json({ ok: false, error: "Файл не найден" }, { status: 404 })
          }
          if (!canAccessRel(rel, currentAuth)) {
            return Response.json({ ok: false, error: "Нет доступа к этому файлу" }, { status: 403 })
          }
          rmSync(abs)
          let dirRemoved = false
          const dir = dirname(abs)
          try {
            if (readdirSync(dir).length === 0) {
              rmSync(dir, { recursive: true, force: true })
              dirRemoved = true
              // Убираем опустевшую папку проекта (новый формат), кроме корня.
              const parent = dirname(dir)
              if (basename(parent) !== basename(RESULTS_ROOT)) {
                try { if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true }) } catch {}
              }
            }
          } catch {}
          log("deleted file: " + rel + (dirRemoved ? " (папка удалена)" : ""))
          invalidateProjectsIndex()
          return Response.json({ ok: true, dirRemoved })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "POST" && url.pathname === "/api/delete-all") {
        try {
          const body = await readBody(req)
          const host = String(body.host || "").trim()
          const selectedHost = host ? sanitizeHost(host).toLowerCase() : ""
          let removed = 0
          let dirs = 0
          for (const run of listRuns()) {
            if (selectedHost && sanitizeHost(run.host).toLowerCase() !== selectedHost) continue
            // Сотрудник удаляет только свои запуски; админ — все.
            if (!hasGlobalAccess(currentAuth) && readOwner(run.abs) !== currentAuth.uid) continue
            try {
              removed += scanResults(run.abs).length
              rmSync(run.abs, { recursive: true, force: true })
              dirs++
              // Если папка проекта (новый формат) опустела — убираем и её.
              const parent = dirname(run.abs)
              if (basename(parent) !== basename(RESULTS_ROOT)) {
                try { if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true }) } catch {}
              }
            } catch {}
          }
          log(`delete-all: host=${host || "*"} files=${removed} dirs=${dirs}`)
          invalidateProjectsIndex()
          return Response.json({ ok: true, removed, dirs })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "GET" && url.pathname === "/api/download") {
        const rel = url.searchParams.get("file") || ""
        const abs = safePath(RESULTS_ROOT, rel)
        if (!abs || !existsSync(abs) || !statSync(abs).isFile()) {
          return Response.json({ ok: false, error: "Файл не найден" }, { status: 404 })
        }
        if (!canAccessRel(rel, currentAuth)) {
          return Response.json({ ok: false, error: "Нет доступа к этому файлу" }, { status: 403 })
        }
        const fname = encodeURIComponent(basename(abs))
        return new Response(readFileSync(abs), {
          headers: {
            "Content-Type": ctypeFor(ext(abs)),
            "Content-Disposition": `attachment; filename*=UTF-8''${fname}`,
          },
        })
      }

      if (req.method === "GET" && url.pathname === "/api/preview") {
        const rel = url.searchParams.get("file") || ""
        const abs = safePath(RESULTS_ROOT, rel)
        if (!abs || !existsSync(abs)) {
          return Response.json({ ok: false, error: "Файл не найден" }, { status: 404 })
        }
        if (!canAccessRel(rel, currentAuth)) {
          return Response.json({ ok: false, error: "Нет доступа к этому файлу" }, { status: 403 })
        }
        const e = ext(abs).toLowerCase()
        if (e !== ".csv") {
          return Response.json({ ok: true, csv: false, note: "CSV-предпросмотр доступен только для .csv. Скачай файл." })
        }
        let text: string
        try {
          text = readFileSync(abs, "utf8")
        } catch {
          text = readFileSync(abs, "latin1")
        }
        try {
          const rows = parseCsv(text)
          return Response.json({ ok: true, csv: true, rows })
        } catch (err) {
          return Response.json({ ok: false, error: String(err) })
        }
      }

      if (req.method === "POST" && url.pathname === "/run-extract") {
        try {
          const body = await readBody(req)
          const site = String(body.url || "").trim()
          const checks: string[] = Array.isArray(body.checks) ? body.checks.map(String) : []

          if (!site) return Response.json({ ok: false, error: "URL сайта не указан" })
          if (checks.length === 0) return Response.json({ ok: false, error: "Не выбрано ни одного элемента" })

          const host = hostFromUrl(site) || deriveHostFromText(site) || "project"
          const outDir = makeRunDir(host, currentAuth, { category: "extract", task: "extract" })
          const task = mkTask("extract", "Выгрузка метатегов — " + site)
          task.host = host
          task.outDir = outDir

          const hasHeadings = checks.some((c) => /^h[1-6]$/i.test(c))
          const metaCols = checks.filter((c) => !/^h[1-6]$/i.test(c)).join(", ")
          let taskText = `Собери метатеги с ${site} в таблицу.`
          taskText += `\n\nИзвлекай: ${metaCols || "—"}${hasHeadings ? ", " + checks.filter((c)=>/^h[1-6]$/i.test(c)).join(", ") : ""}.`
          if (hasHeadings) taskText += "\nВключи колонки заголовков: " + checks.filter((c)=>/^h[1-6]$/i.test(c)).join(", ") + "."

          const prompt = `Запусти навык ${SKILL_EXTRACT} (см. SKILL.md) и выполни задание.\n\n${taskText}\n\nСОХРАНИ РЕЗУЛЬТАТЫ ТОЛЬКО В ЭТУ ПАПКУ:\n${outDir}\n\nСохрани все итоговые файлы в эту папку (Метатеги_<хост>.csv, при необходимости .xlsx и отдельная таблица заголовков). НЕ создавай и не пиши файлы в других местах. Выведи в чат путь к файлам.`
          await sendPrompt(prompt, task.id)
          return Response.json({ ok: true, host, outDir, taskId: task.id })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "POST" && url.pathname === "/run-microdata") {
        try {
          const body = await readBody(req)
          const site = String(body.url || "").trim()
          if (!site) return Response.json({ ok: false, error: "URL сайта не указан" })
          const host = hostFromUrl(site) || deriveHostFromText(site) || "project"
          const outDir = makeRunDir(host, currentAuth, { category: "microdata", task: "microdata" })
          const task = mkTask("microdata", "Аудит микроразметки — " + site)
          task.host = host
          task.outDir = outDir
          task.tab = "results"
          const prompt = `Запусти навык ${SKILL_MICRODATA} (см. SKILL.md) и выполни задание по аудиту микроразметки Schema.org и OpenGraph.

Сайт: ${site}

Обойди сайт (sitemap.xml или внутренние ссылки), собери все существующие типы разметки Schema.org (JSON-LD и Microdata) и OpenGraph. Проверь обязательные поля, синтаксис и корректность типов под контент, выяви ошибки, дублирование и избыточную/неверную разметку. Отдельно подбери применимые, но отсутствующие типы разметки и приведи готовые примеры для внедрения.

Сформируй XLSX-таблицу «Микроразметка_${host}.xlsx» со структурой справочника Schema.org (колонки: №, Размечаемый элемент, Инструкция (schema.org), Синтаксис (реком.), Поддерживается, Обязательные поля *, Где размечаем на ${host}, Что размечаем, Статус на сайте, Рекомендации по исправлению), а также листами «OpenGraph» и «Справка».

СОХРАНИ РЕЗУЛЬТАТЫ ТОЛЬКО В ЭТУ ПАПКУ:
${outDir}

НЕ создавай и не записывай файлы в других местах. Выведи в чат путь к файлу и краткую сводку: какие типы разметки есть, ключевые ошибки, что рекомендуется добавить.`
          await sendPrompt(prompt, task.id)
          return Response.json({ ok: true, host, outDir, taskId: task.id })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "GET" && req.url.includes("/api/wordstat/regions")) {
        try {
          const regions = await fetchWordstatRegions()
          return Response.json({ ok: true, regions })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "POST" && url.pathname === "/run-wordstat") {
        try {
          const body = await readBody(req)
          const queries: string[] = Array.isArray(body.queries) ? body.queries.map((q: unknown) => String(q).trim()).filter((q: string) => q) : []
          if (queries.length === 0) return Response.json({ ok: false, error: "Список запросов пуст" })
          const regionId = String(body.regionId || "all")
          const regionName = String(body.regionName || "Все регионы")
          const period = String(body.period || "Последний год")
          const device = String(body.device || "десктопы")
          const breakRaw = String(body.breakRaw || "month")
          const breakLabel = String(body.breakLabel || "по месяцам")
          const account = String(body.account || "")
          // Wordstat не привязан к сайту: ключ проекта берём из runDir, иначе "wordstat".
          const hostKey = sanitizeHost(String(body.runDir || "").trim()) || "wordstat"
          const runDir = makeRunDir(hostKey, currentAuth, { category: "wordstat", task: "wordstat" })
          const task = mkTask("wordstat", `Wordstat — ${queries.length} запросов`)
          task.outDir = runDir
          task.host = hostKey

          const prompt = `Запусти навык ${SKILL_WORDSTAT} (см. SKILL.md) и выполни задание.

Список запросов (по одному на строку):
${queries.map((q) => " - " + q).join("\n")}

Период на графике (диапазон месяцев, формат с YYYY-MM по YYYY-MM): ${period}
Регион: ${regionName} (идентификатор региона в Wordstat: ${regionId} — используй его в параметре region= URL, для «Все регионы» region=all)
Устройства: ${device}
Разбивка на графике (вкладка «Динамика»): ${breakLabel} (внутреннее значение: ${breakRaw})
${account ? "Логин в Яндекс (для авторизации в окне браузера): " + account : ""}

СОХРАНИ РЕЗУЛЬТАТЫ ТОЛЬКО В ЭТУ ПАПКУ:
${runDir}

Сохрани ОДИН сводный документ на всё задание: csv/wordstat_<месяцам|неделям|дням>.csv (первый столбец «Период», далее по колонке на каждый запрос). Все промежуточные/рабочие файлы (frequencies.tsv и прочие) складывай в подпапку _raw/ внутри папки результатов. Отдельные файлы по каждому запросу НЕ создавай. Готовые файлы — в папке результатов, ничего в других местах. Выведи в чат путь к файлам и сводную таблицу.`
          await sendPrompt(prompt, task.id)
          return Response.json({ ok: true, runDir, taskId: task.id })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "POST" && url.pathname === "/run-topics") {
        try {
          const body = await readBody(req)
          const site = String(body.url || "").trim()
          if (!site) return Response.json({ ok: false, error: "URL сайта не указан" })

          const competitors: string[] = Array.isArray(body.competitors) ? body.competitors.map((q: unknown) => String(q).trim()).filter((q: string) => q) : []
          const account = String(body.account || "").trim()
          let count = parseInt(String(body.count ?? "10"), 10)
          if (isNaN(count)) count = 10
          count = Math.max(1, Math.min(50, count))

          const host = hostFromUrl(site) || deriveHostFromText(site) || "project"
          const outDir = makeRunDir(host, currentAuth, { category: "topics", task: "topics" })
          const task = mkTask("topics", "Темы статей — " + site)
          task.host = host
          task.outDir = outDir

          // Память по конкурентам: сразу сохраняем в стабильный кэш, чтобы
          // переиспользовать в будущих запусках. Пользовательские URL приоритетны.
          if (competitors.length) {
            try {
              const cacheDir = join(projectDir, ".opencode", "seo-cache", sanitizeHost(host))
              mkdirSync(cacheDir, { recursive: true })
              const compPath = join(cacheDir, "competitors.json")
              let cache: any = { checked_at: new Date().toISOString(), sites: [] }
              if (existsSync(compPath)) {
                try { cache = JSON.parse(readFileSync(compPath, "utf8")) } catch {}
              }
              if (!Array.isArray(cache.sites)) cache.sites = []
              const known = new Set(cache.sites.map((s: any) => String(s.host || s.url || "")))
              for (const raw of competitors) {
                const u = String(raw).trim()
                if (!u) continue
                const h = hostFromUrl(u) || deriveHostFromText(u) || u
                if (known.has(h)) continue
                known.add(h)
                cache.sites.push({ host: h, url: u, source: "user" })
              }
              cache.checked_at = new Date().toISOString()
              writeFileSync(compPath, JSON.stringify(cache, null, 2))
              log("competitors cached for " + host + ": " + cache.sites.length)
            } catch (e) {
              log("competitors cache failed: " + String(e))
            }
          }

          const competitorsLine = competitors.length
            ? "URL конкурентов (переданные пользователем — имеют приоритет, использовать их и запомнить в кэше):\n" + competitors.map((c) => " - " + c).join("\n")
            : "URL конкурентов не указаны — возьми из кэша .opencode/seo-cache/<host>/competitors.json, если они свежие; иначе найди самостоятельно через Яндекс-поиск (yandex.ru/search, не Bing)."

          const prompt = `Запусти навык ${SKILL_TOPICS} (см. SKILL.md) и выполни задание.

Сайт (главная): ${site}

Задание:
- Найди и проанализируй блок статей/блога на сайте (системы /blog/, /news/, /articles/, /media-center/ и т.п.), определи какие статьи уже есть, чтобы темы были уникальными. Выведи в чат, какой блок статей найден и сколько в нём материалов.
- Сгенерируй ${count} уникальных тем для статей.
- Собери семантическое ядро с частотностью Wordstat (регион Россия). Для КАЖДОЙ темы собери 6–11 запросов, РАВНОМЕРНО распределённых по частотности, без перекоса в одну группу. Сверхширокие запросы с частотностью ВЫШЕ 30 000 показов/мес НЕ бери. Градация:
  • ВЧ (высокочастотные): от 10 000 до 30 000 показов — 2–3 запроса;
  • СЧ (среднечастотные): от 1 000 до 10 000 — 2–4 запроса;
  • НЧ (низкочастотные): от 100 до 1 000 (иногда меньше 100, но с реальным спросом) — 2–4 запроса.

${competitorsLine}
${account ? "Логин в Яндекс (для авторизации в окне браузера при сборе Wordstat — подставь его в поле входа): " + account : ""}

Сообщай ход работы этапными маркерами [[stage:N/6]]: 1/6 — старт, 2/6 — после sitemap, 3/6 — после бренд-контекста/статей, 4/6 — после генерации тем, 5/6 — после сбора Wordstat, 6/6 — перед сохранением итоговых файлов. Это нужно для прогресс-бара.

СОХРАНИ РЕЗУЛЬТАТЫ (итоговый файл Темы_для_блога_<host>.xlsx — ОСНОВНОЙ результат и CSV-копию) ТОЛЬКО В ЭТУ ПАПКУ:
${outDir}
Все промежуточные/рабочие файлы (json, tsv, черновики, кэш) складывай в подпапку ${outDir}/_raw/ — в корне папки держи только итоговые Темы_для_блога_<host>.xlsx и .csv.

Используй стабильный кэш (.opencode/brand-context/<host>.json, .opencode/seo-cache/<host>/) как описано в SKILL.md: переиспользуй sitemap, бренд-контекст, найденные ранее статьи, конкурентов и уже собранные частотности Wordstat, если они свежие (младше 30 дней), и накопительно учитывай темы из прошлых запусков, чтобы новые темы с ними не пересекались.

НЕ создавай и не записывай файлы в других местах (не создавай папку seo-content/<host> вне этой папки — используй ${outDir} как корень). Выведи в чат путь к файлам (XLSX и CSV) и краткую сводку тем.`
          await sendPrompt(prompt, task.id)
          return Response.json({ ok: true, host, outDir, taskId: task.id })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "POST" && url.pathname === "/run-audit-address") {
        try {
          const body = await readBody(req)
          const site = String(body.url || "").trim()
          if (!site) return Response.json({ ok: false, error: "URL сайта не указан" })
          const host = hostFromUrl(site) || deriveHostFromText(site) || "project"
          const outDir = makeRunDir(host, currentAuth, { category: "audit", task: "audit-address" })
          const task = mkTask("audit", "Аудит адресов — " + site)
          task.host = host
          task.outDir = outDir
          task.tab = "a-results"
          const prompt = `Запусти навык ${SKILL_ADRESS} (см. SKILL.md) и выполни задание по пункту 1.1 «Адреса страниц» (технический SEO-аудит сайта).

Сайт: ${site}

Выполни аудит адресации (ЧПУ, технические URL, множественные слеши, www/без-www редирект) и оформи результат в .docx по методологии «Текарт».

СОХРАНИ итоговый .docx-файл под именем «Адреса страниц.docx» (имя файла — по названию задания, без названия сайта) ТОЛЬКО В ЭТУ ПАПКУ:
${outDir}

НЕ создавай и не записывай файлы в других местах. Выведи в чат путь к файлу и краткую сводку проблем/рекомендаций.`
          await sendPrompt(prompt, task.id)
          return Response.json({ ok: true, host, outDir, taskId: task.id })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "POST" && url.pathname === "/run-audit-duplicates") {
        try {
          const body = await readBody(req)
          const site = String(body.url || "").trim()
          if (!site) return Response.json({ ok: false, error: "URL сайта не указан" })
          const host = hostFromUrl(site) || deriveHostFromText(site) || "project"
          const outDir = makeRunDir(host, currentAuth, { category: "audit", task: "audit-duplicates" })
          const task = mkTask("duplicates", "Аудит дубликатов — " + site)
          task.host = host
          task.outDir = outDir
          task.tab = "a-results"
          const prompt = `Запусти навык ${SKILL_DUPLICATES} (см. SKILL.md) и выполни задание по пункту 1.2 «Дубликаты страниц» (технический SEO-аудит сайта).

Сайт: ${site}

Найди все дубликаты страниц — страницы с одинаковым (или почти одинаковым) контентом, доступные по разным URL с кодом отклика 200. Собери страницы краулингом (sitemap.xml, если он есть и рабочий), извлеки основной контент и сравни его между адресами. Учти типовые причины: index-файлы, пагинация, параметры URL (в т.ч. регистр, лишние символы, дублирование параметра, URL-кодирование), слеши, www/без-www.

Оформи результат в .docx по методологии «Текарт»: подводка (чем дубликаты плохи для SEO), найденные проблемы и таблица с колонками «Исходная страница» и «Дубликат», затем рекомендации по исправлению.

СОХРАНИ итоговый .docx-файл под именем «Дубликаты страниц.docx» (имя файла — по названию задания, без названия сайта) ТОЛЬКО В ЭТУ ПАПКУ:
${outDir}

При необходимости сохрани рядом полный список дубликатов в CSV. НЕ создавай и не записывай файлы в других местах. Выведи в чат путь к файлу и краткую сводку найденных дубликатов.`
          await sendPrompt(prompt, task.id)
          return Response.json({ ok: true, host, outDir, taskId: task.id })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "POST" && url.pathname === "/run-audit-responses") {
        try {
          const body = await readBody(req)
          const site = String(body.url || "").trim()
          if (!site) return Response.json({ ok: false, error: "URL сайта не указан" })
          const host = hostFromUrl(site) || deriveHostFromText(site) || "project"
          const outDir = makeRunDir(host, currentAuth, { category: "audit", task: "audit-responses" })
          const task = mkTask("responses", "Аудит откликов сервера — " + site)
          task.host = host
          task.outDir = outDir
          task.tab = "a-results"
          const prompt = `Запусти навык ${SKILL_RESPONSES} (см. SKILL.md) и выполни задание по пункту 1.3 «Заголовки откликов сервера» (технический SEO-аудит сайта).

Сайт: ${site}

Обойди сайт по внутренней перелинковке, собери все внутренние ссылки (<a href>) вместе со страницами-источниками и проверь код отклика сервера каждой страницы-цели (без следования редиректам). Оставь только адреса с откликом не 200 — страницы с откликом 200 в отчёт не включай.

Оформи результат в .docx по методологии «Текарт»: подводка (зачем поддерживать корректные отклики сервера), таблица «URL — URL на странице — Отклик — Рекомендация» (только не-200) и рекомендации по исправлению.

СОХРАНИ итоговый .docx-файл под именем «Заголовки откликов сервера.docx» (имя файла — по названию задания, без названия сайта) ТОЛЬКО В ЭТУ ПАПКУ:
${outDir}

При необходимости сохрани рядом таблицу откликов в CSV. НЕ создавай и не записывай файлы в других местах. Выведи в чат путь к файлу и краткую сводку не-200 откликов.`
          await sendPrompt(prompt, task.id)
          return Response.json({ ok: true, host, outDir, taskId: task.id })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "POST" && url.pathname === "/run-audit-indexing") {
        try {
          const body = await readBody(req)
          const site = String(body.url || "").trim()
          if (!site) return Response.json({ ok: false, error: "URL сайта не указан" })
          const host = hostFromUrl(site) || deriveHostFromText(site) || "project"
          const outDir = makeRunDir(host, currentAuth, { category: "audit", task: "audit-indexing" })
          const task = mkTask("indexing", "Аудит индексации — " + site)
          task.host = host
          task.outDir = outDir
          task.tab = "a-results"
          const prompt = `Запусти навык ${SKILL_INDEXING} (см. SKILL.md) и выполни задание по пункту 1.4 «Индексация сайта» (технический SEO-аудит сайта).

Сайт: ${site}

Проверь три служебных файла сайта: robots.txt (1.4.1), sitemap.xml (1.4.2) и llms.txt (1.4.3). Для каждого:
- загрузи файл и проверь код отклика (наличие/отсутствие);
- напиши краткую подводку (зачем файл нужен с точки зрения SEO);
- выяви ошибки и проблемы: синтаксис, дубли, полноту, соответствие canonical-хосту (https/www), коды отклика URL в sitemap (должны быть только 200);
- обязательно учти CMS сайта (какие технические разделы нужно закрыть/открыть в robots.txt);
- сформируй рекомендации по аналогии с образцом аудита Frontside.ru (robots.txt — готовый вид файла; sitemap — priority/changefreq по разделам таблицей; llms.txt — структура и правила).

Оформи результат в один .docx по методологии «Текарт» с подпунктами 1.4.1 Robots.txt, 1.4.2 Sitemap, 1.4.3 llms.txt.

СОХРАНИ итоговый .docx-файл под именем «Индексация сайта.docx» (имя файла — по названию задания, без названия сайта) ТОЛЬКО В ЭТУ ПАПКУ:
${outDir}

НЕ создавай и не записывай файлы в других местах. Выведи в чат путь к файлу и краткую сводку по каждому из трёх файлов.`
          await sendPrompt(prompt, task.id)
          return Response.json({ ok: true, host, outDir, taskId: task.id })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "POST" && url.pathname === "/run-audit-topology") {
        try {
          const body = await readBody(req)
          const site = String(body.url || "").trim()
          if (!site) return Response.json({ ok: false, error: "URL сайта не указан" })
          const host = hostFromUrl(site) || deriveHostFromText(site) || "project"
          const outDir = makeRunDir(host, currentAuth, { category: "audit", task: "audit-topology" })
          const task = mkTask("topology", "Аудит топологии — " + site)
          task.host = host
          task.outDir = outDir
          task.tab = "a-results"
          const prompt = `Запусти навык ${SKILL_TOPOLOGY} (см. SKILL.md) и выполни задание по пункту 1.5 «Внутренняя ссылочная топология» (технический SEO-аудит сайта).

Сайт: ${site}

Обойди сайт по внутренним ссылкам (меню, футер, контекстные ссылки) и построй граф внутренних ссылок: глубина страниц от главной, входящие и исходящие ссылки, сквозные (шаблонные) и контекстные ссылки. Оцени структуру и логику разделов, вложенность, хлебные крошки, «страницы-сироты» и слабо связанные страницы, навигацию внутри разделов, дублирование меню, текстовые анкоры, HTML-карту сайта, футер и тематическую связность разделов.

Оформи результат в .docx по методологии «Текарт»: подводка (зачем нужна внутренняя ссылочная топология), выявленные проблемы с примерами URL и таблицей «Страница — Входящих ссылок — Откуда доступна», положительные моменты и общие рекомендации по исправлению.

СОХРАНИ итоговый .docx-файл под именем «Внутренняя ссылочная топология.docx» (имя файла — по названию задания, без названия сайта) ТОЛЬКО В ЭТУ ПАПКУ:
${outDir}

При необходимости сохрани рядом таблицу входящих ссылок в CSV. НЕ создавай и не записывай файлы в других местах. Выведи в чат путь к файлу и краткую сводку проблем топологии.`
          await sendPrompt(prompt, task.id)
          return Response.json({ ok: true, host, outDir, taskId: task.id })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "POST" && url.pathname === "/run-audit") {
        try {
          const ctype = req.headers.get("content-type") || ""
          let site = ""
          let rawPoints: any[] = []
          let semcoreMsg = ""
          // Отдельные глубины: 2.1 «Текстовый контент» (по умолчанию 50) и
          // 4.1 «Скорость загрузки» (по умолчанию 10 — только ключевые страницы).
          let depthContent = 50
          let depthSpeed = 10
          let form: any = null
          let body: any = null
          if (ctype.includes("multipart/form-data")) {
            form = await req.formData()
            site = String(form.get("url") || "").trim()
            try { rawPoints = JSON.parse(String(form.get("points") || "[]")) } catch { rawPoints = [] }
            const dc = parseInt(String(form.get("depthContent") || form.get("depth") || ""), 10)
            if (!isNaN(dc) && dc > 0) depthContent = dc
            const ds = parseInt(String(form.get("depthSpeed") || ""), 10)
            if (!isNaN(ds) && ds > 0) depthSpeed = ds
            const file = form.get("semcore")
            if (file && typeof file !== "string" && file.size > 0) {
              if (file.size > 50 * 1024 * 1024) return Response.json({ ok: false, error: "Файл семантического ядра больше 50 МБ" })
              const name = String(file.name || "semcore").replace(/[^\w.\-а-яА-ЯёЁ ]+/gu, "_")
              const savedPath = join(uploadDir, `semcore_${Date.now()}_${name}`)
              writeFileSync(savedPath, new Uint8Array(await file.arrayBuffer()))
              semcoreMsg = `\nСемантическое ядро (для пункта 2.3 «Служебные теги»): ${savedPath}\nЕсли среди выбранных пунктов есть 2.3, составь скорректированные title/description по этому семантическому ядру (на каждую страницу — свой кластер запросов).\n`
            }
          } else {
            body = await readBody(req)
            site = String(body.url || "").trim()
            rawPoints = Array.isArray(body.points) ? body.points : []
            const dc = parseInt(String(body.depthContent || body.depth || ""), 10)
            if (!isNaN(dc) && dc > 0) depthContent = dc
            const ds = parseInt(String(body.depthSpeed || ""), 10)
            if (!isNaN(ds) && ds > 0) depthSpeed = ds
          }
          const dryRun = ctype.includes("multipart/form-data")
            ? String(form.get("dryRun") || "").toLowerCase() === "true" || String(form.get("dryRun") || "").toLowerCase() === "on"
            : String((body as any)?.dryRun || "").toLowerCase() === "true"
          if (!site) return Response.json({ ok: false, error: "URL сайта не указан" })
          return Response.json(enqueueAudit({
            dryRun,
            site,
            points: rawPoints
              .map((p) => ({ point: String((p && p.point) || "").trim(), skill: String((p && p.skill) || "").trim() }))
              .filter((p) => p.point && p.skill),
            owner: hasGlobalAccess(currentAuth) ? "admin" : currentAuth.uid,
            auth: currentAuth, depthContent, depthSpeed, semcoreMsg,
          }))
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "GET" && url.pathname === "/api/audit-queue") {
        try {
          const isAdmin = hasGlobalAccess(currentAuth)
          const mine = [...auditJobs.values()].filter((j) => isAdmin || j.owner === currentAuth.uid)
          const queuedSorted = mine.filter((j) => j.status === "queued").sort((a, b) => a.enqueuedAt - b.enqueuedAt)
          const jobs = [
            ...mine.filter((j) => j.status === "running").map((j) => ({ id: j.id, site: j.site, status: "running", stateLabel: "выполняется", eta: "выполняется" })),
            ...queuedSorted.map((j, i) => ({ id: j.id, site: j.site, status: "queued", stateLabel: "в очереди", position: i + 1,
              eta: fmtEta(auditEtaMinutes(i + 1)) })),
          ]
          return Response.json({ ok: true, running: auditRunning, max: auditMaxConcurrent(), jobs })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "POST" && url.pathname === "/run-audit-cancel") {
        try {
          const body = await readBody(req)
          const jobId = String(body.jobId || "").trim()
          const job = auditJobs.get(jobId)
          if (!job) return Response.json({ ok: false, error: "Задание не найдено (возможно, уже выполняется или удалено)." })
          if (!hasGlobalAccess(currentAuth) && job.owner !== currentAuth.uid) {
            return Response.json({ ok: false, error: "Можно удалять только свои задания." })
          }
          if (job.status === "running") {
            return Response.json({ ok: false, error: "Аудит уже выполняется — удалить из очереди нельзя." })
          }
          auditJobs.delete(jobId)
          scheduleQueueSave()
          auditLog(`AUDIT_QUEUE_REMOVE ip=${clientIp || "?"} job=${jobId}`)
          return Response.json({ ok: true })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "POST" && url.pathname === "/run-smm-groups") {
        try {
          const body = await readBody(req)
          const groups: string[] = Array.isArray(body.groups)
            ? body.groups.map((g: unknown) => String(g).trim()).filter((g: string) => g)
            : []
          if (groups.length === 0) return Response.json({ ok: false, error: "Не указано ни одной группы" })

          const pad2 = (n: number) => String(n).padStart(2, "0")
          const fmt = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
          const now = new Date()
          const defaultFrom = fmt(new Date(now.getTime() - 30 * 24 * 3600 * 1000))
          const dateFrom = String(body.dateFrom || "").trim() || defaultFrom
          const dateTo = String(body.dateTo || "").trim() || fmt(now)
          const account = String(body.account || "").trim()

          const host = smmProjectKey(groups)
          const outDir = makeRunDir(host, currentAuth, { category: "smm", task: "smm" })
          const task = mkTask("smm", "Анализ групп — " + groups.length + " шт.")
          task.host = host
          task.outDir = outDir
          task.tab = "smm-results"

          const groupsList = groups.map((g) => " - " + g).join("\n")
          const prompt = `Запусти навык ${SKILL_SMM_GROUPS} (см. SKILL.md) и выполни задание по анализу групп в социальных сетях.

Группы/каналы для анализа (ВКонтакте, Telegram, MAX — могут быть вперемешку):
${groupsList}

Период анализа: с ${dateFrom} по ${dateTo} (включительно).
${account ? "Аккаунт для входа (подставь в окно авторизации при необходимости): " + account : "Аккаунт для входа не указан — используй сохранённый профиль; при запросе входа приостанови и сообщи."}

Что нужно сделать:
1. Для каждой группы зайти на страницу и пройти по ОПУБЛИКОВАННЫМ постам ленты за указанный период (не только закреплённые; посты старше «с ${dateFrom}» дальше не собирать).
2. По каждому посту собрать поля (ровно эти колонки, в этом порядке):
   - Ссылка на пост
   - Дата публикации
   - Лайки
   - Репосты
   - Голоса
   - Комментарии
   - Просмотры всего
   - Переходы по ссылкам
   - Количество отписавшихся
   - Количество подписавшихся
   - Просмотры подписчики
   - Просмотры не подписчики
   - Хештег поста
   - Текст поста (без хештега)
3. Если площадка не отдаёт часть статистики (например, в MAX её почти нет) — колонки всё равно оставляй, а недоступные значения — пустыми. Посты и группы НЕ пропускать.
4. Сформировать итоговую таблицу XLSX со всеми постами всех групп: файл SMM_группы_<проект>.xlsx. Первый лист — посты; дополнительно можно лист «Сводка» по группам.

СОХРАНИ РЕЗУЛЬТАТЫ ТОЛЬКО В ЭТУ ПАПКУ:
${outDir}

НЕ создавай и не записывай файлы в других местах. Выведи в чат путь к файлу и краткую сводку (сколько групп и постов собрано, какие поля недоступны).`
          await sendPrompt(prompt, task.id)
          return Response.json({ ok: true, host, outDir, taskId: task.id })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "POST" && url.pathname === "/run-articles") {
        try {
          const ctype = req.headers.get("content-type") || ""
          let site = ""
          let notes = ""
          let articleCount = 10
          let topicsPath = ""
          let materialType = "informational"
          let commercialMode = "new"
          let uploadName = ""
          let uploadedMsg = ""
          let tzSaved = ""

          if (ctype.includes("multipart/form-data")) {
            const form = await req.formData()
            site = String(form.get("url") || "").trim()
            notes = String(form.get("notes") || "").trim()
            articleCount = parseInt(String(form.get("count") || "10"), 10)
            topicsPath = String(form.get("topicsPath") || "").trim()
            materialType = String(form.get("materialType") || "informational").trim()
            commercialMode = String(form.get("commercialMode") || "new").trim()
            const file = form.get("file")
            if (file && typeof file !== "string" && file.size > 0) {
              if (file.size > 50 * 1024 * 1024) return Response.json({ ok: false, error: "Файл ТЗ больше 50 МБ" })
              const name = String(file.name || "tz_upload").replace(/[^\w.\-а-яА-ЯёЁ ]+/gu, "_")
              uploadName = name
              const savedPath = join(uploadDir, `tz_${Date.now()}_${name}`)
              writeFileSync(savedPath, Buffer.from(await file.arrayBuffer()))
              tzSaved = savedPath
              uploadedMsg = `\nЗагруженный файл ТЗ сохранён: ${savedPath}`
            }
          } else {
            const body = await readBody(req)
            site = String(body.url || "").trim()
            notes = String(body.notes || "").trim()
            articleCount = parseInt(String(body.count || "10"), 10)
            topicsPath = String(body.topicsPath || "").trim()
            materialType = String(body.materialType || "informational").trim()
            commercialMode = String(body.commercialMode || "new").trim()
          }

          if (!site) return Response.json({ ok: false, error: "URL сайта не указан" })
          if (isNaN(articleCount)) articleCount = 10
          articleCount = Math.max(1, Math.min(50, articleCount))
          if (topicsPath) {
            const topicsAbs = safePath(RESULTS_ROOT, topicsPath)
            if (!topicsAbs || !existsSync(topicsAbs) || !statSync(topicsAbs).isFile() || !canAccessRel(topicsPath, currentAuth)) {
              if (tzSaved) { try { rmSync(tzSaved, { force: true }) } catch {} }
              return Response.json({ ok: false, error: "Нет доступа к файлу с темами" }, { status: 403 })
            }
            topicsPath = relative(resolve(RESULTS_ROOT), topicsAbs).split(sep).join("/")
          }
          const commercial = materialType === "commercial"
          if (commercialMode !== "rewrite") commercialMode = "new"

          const host = hostFromUrl(site) || deriveHostFromText(site) || "project"
          const outDir = makeRunDir(host, currentAuth)
          const task = mkTask("articles", (commercial ? "Коммерческий текст — " : "Статьи — ") + site)
          // Для статей outDir = корень запуска: навык сам создаёт подпапку articles/.
          task.host = host
          task.outDir = outDir

          let prompt: string
          if (commercial) {
            const modeWord = commercialMode === "rewrite" ? "рерайт существующей страницы" : "новый материал"
            const sourceBlock = tzSaved
              ? `Приложенное ТЗ: ${tzSaved}\nПрочитай его и следуй ему (структура, ключевые слова, требования). ТЗ приоритетно.`
              : "ТЗ не приложено — работай по логике SKILL.md для коммерческого материала."
            const modeBlock = commercialMode === "rewrite"
              ? "Рерайт: возьми текущий текст этой страницы и перепиши его по логике уникализации (смысл и факты сохрани, изложи заново, уникальность >90%), добавь ключевые слова и подсвети их, приведи объём к значению из ТЗ (если задано), иначе к 3000–4000 знакам с пробелами."
              : "Новый материал: уникальный текст с нуля, без воды."
            prompt = `Запусти навык ${SKILL_ARTICLES} (см. SKILL.md) и выполни задание в РЕЖИМЕ КОММЕРЧЕСКОГО МАТЕРИАЛА.

Сайт (для бренд-контекста): ${site}
Коммерческая страница: ${site}
Тип материала: ${modeWord}.

Обязательно перед написанием:
- Открой и внимательно изучи текущую коммерческую страницу (${site}): tone of voice, подача, структура, лексика, оформление. Это главный ориентир по стилю.
- Изучи другие разделы сайта (главную, «О компании», другие услуги/товары) — возьми оттуда фактуру (цифры, преимущества, УТП, контакты, CTA-фразы), если она нужна для текста.

Требования к коммерческому тексту:
- Объём (с пробелами): если в приложенном ТЗ указан объём — строго по ТЗ (например «5000 знаков» → 5000 знаков С ПРОБЕЛАМИ); иначе 3000–4000 знаков с пробелами, не более.
- Тезисы ТЗ — ориентир по содержанию; заголовки можно переформулировать (звучнее + ключ).
- Все ключевые фразы из ТЗ подсветить жёлтым в DOCX (через <mark>).
- В конце документа — блок «H2: Метатеги для страницы» со строками Title: и Description: (по бренд-контексту и запросам из ТЗ).
- Учти прошлые тексты по этому сайту (articles.json/.meta.json и .docx), чтобы не было сильных пересечений.
- Уникально, без воды, без переспама.
- ${modeBlock}
- В конце — обязательный короткий призыв к действию (CTA) со ссылкой.
- Стиль — как на текущей коммерческой странице.

${sourceBlock}
${notes ? "Примечания пользователя:\n" + notes : ""}
${uploadedMsg}
Имя файла материала — С ДАТОЙ И ВРЕМЕНЕМ создания: <slug>_<ГГГГ-ММ-ДД>_<ЧЧММ>.docx (и такой же .meta.json).
СОХРАНИ РЕЗУЛЬТАТ (материал в виде .docx, а также .meta.json и articles.json) ТОЛЬКО В ЭТУ ПАПКУ:
${outDir}

НЕ создавай и не записывай файлы в других местах (не создавай папку seo-content/<host> вне этой папки — используй ${outDir} как корень). Исключение — кэш бренд-контекста: переиспользуй/сохраняй его в .opencode/brand-context/<host>.json и не пересобирай, если он свежий (перепроверка раз в 30 дней). Выведи в чат путь к файлам и краткую сводку.`
          } else {
            let sourceBlock
            if (tzSaved) {
              sourceBlock = `Источник тем — загруженный файл ТЗ: ${tzSaved}\nПрочитай его, извлеки темы, структуру (H2) и ключевые слова.`
            } else if (topicsPath) {
              sourceBlock = `Источник тем — документ, сформированный на прошлом шаге (seo-topics): ${topicsPath}\nПрочитай его (XLSX/CSV/MD; для .xlsx используй scripts/read_topic_file.py), возьми темы из колонки «Название статьи», структуру из «Структура» и ключевые слова из «Запросы из сем ядра».`
            } else {
              sourceBlock = "Источник тем не указан — попроси пользователя или используй сгенерированные темы из выбранного документа."
            }

            prompt = `Запусти навык ${SKILL_ARTICLES} (см. SKILL.md) и выполни задание в РЕЖИМЕ ИНФОРМАЦИОННЫХ СТАТЕЙ.

Сайт (для кого пишем / бренд-контекст): ${site}

Задание: напиши статьи по темам.

${sourceBlock}

Количество статей: ${articleCount} (не больше числа тем в источнике, новые темы не придумывай)

Примечания пользователя${notes ? ":\n" + notes : ": нет (работай по логике, заданной в SKILL.md)"}

Объём — С ПРОБЕЛАМИ (по ТЗ, иначе 5000–7000). Тезисы ТЗ — ориентир, заголовки можно переформулировать. Все ключевые фразы подсветить жёлтым в DOCX (через <mark>). В конце документа добавь блок «H2: Метатеги для страницы» (Title и Description). Учти прошлые тексты по этому сайту, чтобы не было сильных пересечений.
Имя файла материала — С ДАТОЙ И ВРЕМЕНЕМ создания: <slug>_<ГГГГ-ММ-ДД>_<ЧЧММ>.docx (и такой же .meta.json).
${uploadedMsg}
СОХРАНИ РЕЗУЛЬТАТЫ (статьи в виде .docx, а также .meta.json и articles.json) ТОЛЬКО В ЭТУ ПАПКУ:
${outDir}

НЕ создавай и не записывай файлы в других местах (не создавай папку seo-content/<host> вне этой папки — используй ${outDir} как корень). Исключение — кэш бренд-контекста: переиспользуй/сохраняй его в .opencode/brand-context/<host>.json и не пересобирай, если он свежий (перепроверка раз в 30 дней). Выведи в чат путь к файлам и сводку.`
           }
           // Регистрируем второй проход: после генерации запустится копирайтерская полировка (Max).
           articlePolishes.set(task.id, { outDir, host })
           await sendPrompt(prompt, task.id)
           return Response.json({ ok: true, host, outDir, taskId: task.id })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "POST" && url.pathname === "/api/revise") {
        try {
          const body = await readBody(req)
          const rel = String(body.file || "").trim()
          const instruction = String(body.instruction || "").trim()
          if (!rel) return Response.json({ ok: false, error: "Не указан файл" })
          if (!instruction) return Response.json({ ok: false, error: "Не указана инструкция" })
          const abs = safePath(RESULTS_ROOT, rel)
          if (!abs || !existsSync(abs) || !statSync(abs).isFile()) {
            return Response.json({ ok: false, error: "Файл не найден" }, { status: 404 })
          }
          if (!canAccessRel(rel, currentAuth)) {
            return Response.json({ ok: false, error: "Нет доступа к этому файлу" }, { status: 403 })
          }
          if (!abs.toLowerCase().endsWith(".docx")) {
            return Response.json({ ok: false, error: "Правки доступны только для .docx" })
          }
          const outDir = dirname(abs)
          const metaPath = abs.replace(/\.docx$/i, ".meta.json")
          const task = mkTask("articles", "Правки — " + basename(abs))
          task.outDir = outDir
          const relParts = relative(RESULTS_ROOT, outDir).split(sep).filter(Boolean)
          task.host = (relParts[1] || relParts[0] || "project").replace(/_\d{4}-\d{2}-\d{2}$/, "")
          const prompt = `Внеси правки в готовый материал (навык ${SKILL_ARTICLES}, см. SKILL.md, раздел «Правки в готовый материал»).

Файл материала: ${abs}
Метаданные: ${metaPath}

Инструкция пользователя по правкам:
${instruction}

Правила:
- Прочитай текущий .docx и .meta.json, внеси правки строго по инструкции, сохранив факты, структуру и ключевые фразы.
- Пересобери DOCX (ключевые фразы подсветить жёлтым) и ПЕРЕЗАПИШИ файл по тому же пути.
- Обнови content_length / content_length_with_spaces в .meta.json и запись в articles.json.
- Объём — по ТЗ (если известен), иначе по дефолту навыка.
- Сохрани блок «H2: Метатеги для страницы» (Title, Description) в конце документа и синхронизируй с meta_title/meta_description.
- Файлы — только внутри ${outDir}.`
          await sendPrompt(prompt, task.id)
          return Response.json({ ok: true, taskId: task.id, file: rel })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      if (req.method === "POST" && url.pathname === "/run-metatags") {
        try {
          const ctype = req.headers.get("content-type") || ""
          let path = ""
          let newMeta = true
          let metaUrl = ""
          let uploadName = ""
          let uploadedMsg = ""
          if (!ctype.includes("multipart/form-data")) {
            return Response.json({ ok: false, error: "Задание принимается только с загруженным файлом семантического ядра" })
          }
          const form = await req.formData()
          const file = form.get("file")
          newMeta = form.get("newMeta") !== "0"
          metaUrl = String(form.get("metaUrl") || "").trim()
          if (!file || typeof file === "string" || file.size === 0) {
            return Response.json({ ok: false, error: "Файл не получен (пустой upload)" })
          }
          if (file.size > 50 * 1024 * 1024) {
            return Response.json({ ok: false, error: "Файл больше 50 МБ" })
          }
          const name = String(file.name || "sem_core_upload").replace(/[^\w.\-а-яА-ЯёЁ ]+/gu, "_")
          uploadName = name
          const savedPath = join(uploadDir, `core_${Date.now()}_${name}`)
          writeFileSync(savedPath, Buffer.from(await file.arrayBuffer()))
          path = savedPath
          uploadedMsg = `\nФайл загружен из браузера и сохранён: ${savedPath}`

          if (!path) return Response.json({ ok: false, error: "Путь к семядру не указан" })

          const host = hostFromUrl(metaUrl) || deriveHostFromText(metaUrl || path || uploadName) || "project"
          const outDir = makeRunDir(host, currentAuth, { category: "metatags", task: "metatags" })
          const task = mkTask("metatags", "Метатеги по семядру — " + host)
          task.host = host
          task.outDir = outDir

          const prompt = buildMetaTagsPrompt(SKILL_METATAGS, path, newMeta, outDir) + uploadedMsg
          await sendPrompt(prompt, task.id)
          return Response.json({ ok: true, path, host, outDir, taskId: task.id })
        } catch (e) {
          return Response.json({ ok: false, error: String(e) })
        }
      }

      return new Response("Not Found", { status: 404 })
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      server = await startServer(chosenPort, withSecurity(requestHandler))
      break
    } catch (e) {
      // Порт занят. Если его обслуживает наша же SEO-панель (другая копия
      // opencode) — переиспользуем её, чтобы URL оставался статичным.
      if (await probeSeoPanel(chosenPort)) {
        externalServer = true
        log(`порт ${chosenPort} уже обслуживается другой копией SEO-панели — переиспользую (URL стабилен)`)
        break
      }
      if (chosenPort === fixedPort) {
        log(`порт ${fixedPort} занят посторонним сервисом: ${String(e)} — ищу свободный порт`)
      } else {
        log("port " + chosenPort + " busy, trying next: " + String(e))
      }
      chosenPort++
    }
  }

  // Watchdog: если мы переиспользовали чужую копию панели, а она исчезла —
  // поднимаем свою на том же фиксированном порту, чтобы URL оставался доступным.
  if (externalServer) {
    let misses = 0
    const wd = setInterval(async () => {
      if (!externalServer) { clearInterval(wd); return }
      const alive = await probeSeoPanel(fixedPort)
      if (alive) { misses = 0; return }
      misses++
      if (misses < 2) return
      try {
        server = await startServer(fixedPort, withSecurity(requestHandler))
        externalServer = false
        chosenPort = fixedPort
        clearInterval(wd)
        log(`перехватил порт ${fixedPort}: поднял свою SEO-панель`)
      } catch (e) {
        log("не удалось занять порт " + fixedPort + ": " + String(e))
        misses = 0
      }
    }, 15000)
  }

  const activePort = externalServer ? fixedPort : (server?.port ?? chosenPort)
  const urls: string[] = []
  urls.push(`http://localhost:${activePort}`)
  if (lanIp) urls.push(`http://${lanIp}:${activePort}`)
  if (externalServer) {
    log(`UI уже запущен на порту ${activePort} (внешний процесс) — ${urls.join(" · ")}`)
  } else {
    log(`UI server ready on ${BIND_ADDRESS}:${activePort} — ${urls.join(" · ")}`)
  }
  console.log("\n  🌐  SEO-инструменты (доступ из локальной сети):\n")
  for (const u of urls) console.log(`      ${u}`)
  if (BIND_ADDRESS === "127.0.0.1" || BIND_ADDRESS === "localhost") {
    console.log("\n      🔐 Панель слушает только localhost (SEO_UI_BIND=127.0.0.1)")
  }
  if (ALLOW_IPS.length) {
    console.log(`\n      🧱 Allowlist по IP включён: ${ALLOW_IPS.join(", ")}`)
  }
  console.log(`      📝 Журнал аудита: ${AUDIT_LOG}`)
  if (authEnabled()) {
    console.log(`\n      🔒 Авторизация включена.`)
    console.log(`         👑 Админка: http://localhost:${chosenPort}/admin (только роль «администратор»)`)
    console.log(`         Пользователи настраиваются в админке (файл ${ADMIN_FILE}).`)
  } else {
    console.log("\n      ⚠️  Авторизация ОТКЛЮЧЕНА (SEO_UI_AUTH=0) — панель открыта всем в сети")
  }
  console.log("")

  // Авто-ретеншен результатов: раз в 6 часов, если в админке задан срок хранения.
  try {
    const retentionTick = () => {
      try {
        const r = runRetentionCleanup()
        if (r.dirs) log(`retention: удалено запусков ${r.dirs}, файлов ${r.removed} (старше ${r.days} дн.)`)
      } catch (e) { log("retention failed: " + String(e)) }
    }
    const t1 = setTimeout(retentionTick, 60 * 1000)
    const t2 = setInterval(retentionTick, 6 * 60 * 60 * 1000)
    ;(t1 as any).unref?.(); (t2 as any).unref?.()
  } catch {}

  // Восстанавливаем очередь аудитов после рестарта и продолжаем её.
  try {
    if (loadAuditQueueState() > 0) {
      setTimeout(() => { try { pumpAuditQueue() } catch (e) { log("queue pump after restore failed: " + String(e)) } }, 5000)
    }
  } catch {}

  startAuditScheduler()

  // Desktop has no visible plugin console, so open the local UI automatically.
  if (process.platform === "win32" && process.env.OPENCODE_SEO_UI_NO_OPEN !== "1") {
    try {
      const browser = spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", "Start-Process", urls[0]], {
        detached: true,
        stdio: "ignore",
      })
      browser.unref()
    } catch (e) {
      log("failed to open UI browser: " + String(e))
    }
  }

  // ---------------------------------------------------------------------------
  // Geo/AEO tracker (Next.js) — автозапуск вместе с opencode на фиксированном
  // порту 3000, чтобы у коллег был стабильный URL (http://<LAN-IP>:3000/).
  // Production-режим: при необходимости один раз собираем (.next/BUILD_ID),
  // затем поднимаем `next start -p 3000 -H 0.0.0.0`. Процесс гасится в dispose.
  // Отключить: OPENCODE_GEO_TRACKER=0. Порт: OPENCODE_GEO_TRACKER_PORT.
  // ---------------------------------------------------------------------------
  function trackerBuildExists(): boolean {
    try {
      return existsSync(join(TRACKER_DIR, ".next", "BUILD_ID"))
    } catch {
      return false
    }
  }

  function killTracker(): void {
    if (!trackerProc) return
    try {
      // Убиваем всю группу процессов Next.js (next start плодит дочерние воркеры).
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(trackerProc.pid), "/T", "/F"], { stdio: "ignore" })
      } else {
        try { process.kill(-trackerProc.pid, "SIGTERM") } catch { trackerProc.kill("SIGTERM") }
      }
    } catch (e) {
      log("tracker kill failed: " + String(e))
    }
    trackerProc = null
  }

  // Проверяет, отвечает ли geo-трекер на своём порту (реальный статус, а не env).
  async function probeTrackerPort(): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      try {
        const probe = spawn(process.platform === "win32" ? "powershell.exe" : "bash", [
          process.platform === "win32" ? "-Command" : "-lc",
          process.platform === "win32"
            ? `(Test-NetConnection -ComputerName 127.0.0.1 -Port ${TRACKER_PORT}).TcpTestSucceeded`
            : `curl -sS -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${TRACKER_PORT}/ 2>/dev/null || echo 000`,
        ], { stdio: ["ignore", "pipe", "ignore"] })
        let out = ""
        probe.stdout.on("data", (d) => { out += String(d) })
        probe.on("close", () => resolve(process.platform === "win32" ? /True/i.test(out) : /200|30\d/.test(out)))
        probe.on("error", () => resolve(false))
      } catch { resolve(false) }
    })
  }

  // Есть ли внешняя systemd-служба geo-tracker.service (наш случай: она поднимает
  // трекер на порту 3000, поэтому OPENCODE_GEO_TRACKER=0 в плагине — это норма).
  let externalUnitCache: boolean | null = null
  async function hasExternalTrackerUnit(): Promise<boolean> {
    if (externalUnitCache !== null) return externalUnitCache
    if (process.platform === "win32") { externalUnitCache = false; return false }
    externalUnitCache = await new Promise<boolean>((resolve) => {
      try {
        const p = spawn("systemctl", ["--user", "cat", "geo-tracker.service"], { stdio: "ignore" })
        p.on("close", (code) => resolve(code === 0))
        p.on("error", () => resolve(false))
      } catch { resolve(false) }
    })
    return externalUnitCache
  }

  // Реальный статус трекера для футера: опрашиваем порт, учитываем внешнюю службу.
  async function trackerSnapshot() {
    const url = `http://${lanIp || "localhost"}:${TRACKER_PORT}/`
    const external = await hasExternalTrackerUnit()
    const up = await probeTrackerPort()
    const restartable = external || !!trackerProc || process.env.OPENCODE_GEO_TRACKER !== "0"
    let state: string = trackerState
    let message = trackerMessage
    if (up) {
      state = "ready"
      if (external && !trackerProc) message = "служба systemd (geo-tracker.service)"
    } else if (trackerProc) {
      state = trackerState // starting / build — наш процесс ещё поднимается
    } else if (external) {
      state = "error"
      message = `служба geo-tracker не отвечает на порту ${TRACKER_PORT}`
    } else if (process.env.OPENCODE_GEO_TRACKER === "0") {
      state = "off"
      message = "отключён (OPENCODE_GEO_TRACKER=0)"
    } else if (trackerState === "ready") {
      state = "error"
      message = "процесс не отвечает"
    }
    return { ok: true, state, message, port: TRACKER_PORT, url, external, restartable }
  }

  async function startTracker(): Promise<void> {
    if (process.env.OPENCODE_GEO_TRACKER === "0") {
      trackerState = "off"
      trackerMessage = "отключён (OPENCODE_GEO_TRACKER=0)"
      return
    }
    if (!existsSync(TRACKER_DIR)) {
      trackerState = "off"
      trackerMessage = "папка geo-aeo-tracker не найдена"
      log("geo tracker: " + trackerMessage)
      return
    }
    // Если порт уже слушается — значит трекер уже запущен (вручную или прошлым
    // процессом). Не поднимаем второй, просто фиксируем «готов».
    const busy = await new Promise<boolean>((resolve) => {
      try {
        const probe = spawn(process.platform === "win32" ? "powershell.exe" : "bash", [
          process.platform === "win32" ? "-Command" : "-lc",
          process.platform === "win32"
            ? `(Test-NetConnection -ComputerName 127.0.0.1 -Port ${TRACKER_PORT}).TcpTestSucceeded`
            : `command -v ss >/dev/null 2>&1 && ss -tln | grep -q ':${TRACKER_PORT} ' && echo busy || echo free`,
        ], { stdio: ["ignore", "pipe", "ignore"] })
        let out = ""
        probe.stdout.on("data", (d) => { out += String(d) })
        probe.on("close", () => resolve(/busy|True/i.test(out)))
        probe.on("error", () => resolve(false))
      } catch { resolve(false) }
    })
    if (busy) {
      trackerState = "ready"
      trackerMessage = `уже запущен на порту ${TRACKER_PORT}`
      log("geo tracker: " + trackerMessage)
      return
    }

    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"

    // 1) При отсутствии production-сборки — собрать один раз.
    if (!trackerBuildExists()) {
      trackerState = "build"
      trackerMessage = "сборка production-версии (одноразово, может занять 1–2 минуты)…"
      log("geo tracker: " + trackerMessage)
      const built = await new Promise<boolean>((resolve) => {
        try {
          const b = spawn(npmCmd, ["run", "build"], {
            cwd: TRACKER_DIR,
            stdio: "ignore",
            env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
          })
          b.on("close", (code) => resolve(code === 0))
          b.on("error", (e) => { log("tracker build error: " + String(e)); resolve(false) })
        } catch (e) {
          log("tracker build spawn failed: " + String(e))
          resolve(false)
        }
      })
      if (!built) {
        trackerState = "error"
        trackerMessage = "не удалось собрать tracker (npm run build)"
        log("geo tracker: " + trackerMessage)
        return
      }
    }

    // 2) Запуск production-сервера на фиксированном порту.
    try {
      trackerState = "starting"
      trackerMessage = `запуск на порту ${TRACKER_PORT}…`
      const child = spawn(npmCmd, ["run", "start", "--", "-p", String(TRACKER_PORT), "-H", "0.0.0.0"], {
        cwd: TRACKER_DIR,
        stdio: "ignore",
        detached: process.platform !== "win32",
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", PORT: String(TRACKER_PORT) },
      })
      trackerProc = child
      child.on("exit", (code) => {
        // Игнорируем выход старого процесса, если уже запущен новый (рестарт).
        if (trackerProc !== child) return
        log("geo tracker exited with code " + code)
        trackerState = "off"
        trackerMessage = "остановлен"
        trackerProc = null
      })
      // Небольшая пауза и проверка, что порт поднялся.
      await new Promise((r) => setTimeout(r, 2500))
      const ok = await new Promise<boolean>((resolve) => {
        try {
          const probe = spawn("bash", ["-lc", `curl -sS -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${TRACKER_PORT}/ 2>/dev/null || echo 000`], { stdio: ["ignore", "pipe", "ignore"] })
          let out = ""
          probe.stdout.on("data", (d) => { out += String(d) })
          probe.on("close", () => resolve(/200|30\d/.test(out)))
          probe.on("error", () => resolve(false))
        } catch { resolve(false) }
      })
      trackerState = ok ? "ready" : "starting"
      trackerMessage = ok ? `готов — http://${lanIp || "localhost"}:${TRACKER_PORT}/` : `запускается на порту ${TRACKER_PORT}…`
      log("geo tracker: " + trackerMessage)
    } catch (e) {
      trackerState = "error"
      trackerMessage = "ошибка запуска: " + String(e)
      log("geo tracker: " + trackerMessage)
    }
  }

  // Запускаем трекер в фоне, не блокируя старт opencode.
  setTimeout(() => { startTracker().catch((e) => log("startTracker failed: " + String(e))) }, 1500)

  const trackerUrl = `http://${lanIp || "localhost"}:${TRACKER_PORT}/`
  log(`geo tracker будет доступен: ${trackerUrl}`)
  if (process.env.OPENCODE_GEO_TRACKER !== "0") {
    console.log("\n  🛰️   Geo/AEO tracker (автозапуск, фиксированный порт " + TRACKER_PORT + "):\n")
    console.log(`      ${trackerUrl}`)
    if (trackerBuildExists()) {
      console.log("      (production-сборка готова)")
    } else {
      console.log("      (потребуется одноразовая сборка, ~1–2 мин в фоне)")
    }
    console.log("")
  }

  async function handleEvent(event: any): Promise<void> {
      if (event.type === "session.created" || event.type === "session.updated") {
        const id = (event as any)?.properties?.info?.id as string | undefined
        if (id) activeSessionID = id
        return
      }
      if (event.type === "message.updated") {
        const info = (event as any)?.properties?.info
        const sid = info?.sessionID as string | undefined
        if (sid) activeSessionID = sid
        if (info?.role === "assistant" && info?.error) {
          const t = taskForSession(sid)
          if (t) {
            // Бесплатная модель упала — сначала пробуем повторить на платной.
            if (escalateToPaid(t)) return
            updateTask(t.id, { status: "error", message: errorText(info.error) })
            invalidateProjectsIndex()
            const fu = auditFollowups.get(t.id)
            if (fu && fu.scriptPrompt) {
              // Каскад при сбое бесплатной модели: free1 (longcat) → free2 (space-bunny) → flash.
              const stage = fu.freeStage ?? 0
              if (stage < 2) {
                fu.freeStage = stage + 1
                try {
                  auditFollowups.delete(t.id)
                  // Повтор — в той же задаче, чтобы статус не мигал «ошибка».
                  updateTask(t.id, { status: "running", label: t.label + (stage === 0 ? " · повтор free2" : " · повтор на платной") })
                  auditFollowups.set(t.id, fu)
                  const mdl = stage === 0 ? currentFree2Model() : currentMainModel()
                  await sendPrompt(fu.scriptPrompt, t.id, fu.host, mdl)
                  log("audit scripts retry stage " + fu.freeStage + ": " + t.id)
                } catch (e) {
                  log("audit scripts retry failed: " + String(e))
                  finishAuditJob(fu.jobId)
                }
              } else {
                auditFollowups.delete(t.id)
                finishAuditJob(fu.jobId)
              }
            } else if (t.auditJobId) {
              finishAuditJob(t.auditJobId)
            }
          }
        }
        return
      }
      if (event.type === "session.status") {
        const props = (event as any)?.properties
        const sid = props?.sessionID as string | undefined
        const status = props?.status
        if (status?.type === "busy") {
          const t = taskForSession(sid)
          if (t) { markTaskActive(t.id); updateTask(t.id, { message: "Выполняется…" }) }
        }
        return
      }
      if (event.type === "session.idle") {
        const sid = (event as any)?.properties?.sessionID
        const t = taskForSession(sid)
        log(`[diag] session.idle sid=${sid || "?"} -> task=${t ? t.id : "none"}`)
        if (t && Date.now() - t.startedAt > 1500) {
          const fu = auditFollowups.get(t.id)
          if (fu) {
            // Идемпотентный дозапуск: если первый (скриптовый) этап оборвался —
            // догоняем ТОЛЬКО невыполненные пункты, и лишь потом выводы. Не более
            // двух попыток, чтобы не зациклиться; лимиты/нагрузку не увеличивает
            // (переобход уже готового не делается).
            const stageDone = existsSync(join(fu.outDir, ".scripts_done"))
            const missing = (!stageDone && fu.scriptPrompt && fu.scriptPts)
              ? missingScriptPoints(fu.outDir, fu.scriptPts) : []
            const attempts = fu.resumeAttempts || 0
            if (missing.length && attempts < 2) {
              fu.resumeAttempts = attempts + 1
              try {
                updateTask(t.id, { status: "running",
                  message: "Дозапускаю невыполненные пункты: " + missing.join(", ") + "…" })
                const missPts = fu.scriptPts!.filter((p) => missing.includes(p.point))
                await sendPrompt(buildScriptResumePrompt(fu.site || fu.host, fu.outDir, missPts),
                  t.id, fu.host, currentFreeModel())
                log("audit scripts resume " + fu.resumeAttempts + " in task " + t.id + ": " + missing.join(","))
              } catch (e) {
                log("audit scripts resume failed: " + String(e))
              }
              return
            }
            // Следующий этап аудита идёт В ТОЙ ЖЕ задаче, чтобы статус не показывал «готово» раньше времени.
            auditFollowups.delete(t.id)
            try {
              if (fu.label) updateTask(t.id, { label: fu.label })
              const job = fu.jobId ? auditJobs.get(fu.jobId) : undefined
              if (job) job.currentTaskId = t.id
              await sendPrompt(fu.prompt, t.id, fu.host, currentMainModel())
              updateTask(t.id, { status: "running", message: "Данные собраны. Собираю выводы и единый документ…" })
              log("audit stage 2 started in same task: " + t.id)
            } catch (e) {
              log("audit followup failed: " + String(e))
              clearIdleTimer(t.id)
              updateTask(t.id, { status: "done", message: "Задание выполнено" })
              invalidateProjectsIndex()
              finishAuditJob(fu.jobId)
            }
          } else {
            // Не завершаем сразу: ждём паузу без активности (см. scheduleTaskDone).
            scheduleTaskDone(t.id)
          }
        }
        return
      }
      if (event.type === "session.error") {
        const props = (event as any)?.properties
        const sid = props?.sessionID as string | undefined
        const err = props?.error
        const t = taskForSession(sid)
        if (t) {
          if (escalateToPaid(t)) return
          clearIdleTimer(t.id); updateTask(t.id, { status: "error", message: errorText(err) }); invalidateProjectsIndex()
        }
        return
      }
      if (event.type === "message.part.updated") {
        const part = (event as any)?.properties?.part
        const sid = part?.sessionID as string | undefined
        const t = taskForSession(sid)
        if (!t) return
        // Любая активность — задача точно выполняется: снимаем «отложенное завершение».
        markTaskActive(t.id)
        if (part?.type === "text" && typeof part.text === "string") {
          // Этапный прогресс: модель присылает маркер [[stage:N/M]].
          const marker = parseStageMarkers(part.text)
          if (marker) setTaskStage(t.id, marker.stage, marker.total)
          // В сообщении маркеры этапов не показываем.
          const cleaned = part.text.replace(/\[\[\s*(?:stage|этап)\s*:\s*\d+\s*\/\s*\d+\s*\]\]/gi, "").trim()
          if (cleaned) {
            const snippet = cleaned.replace(/\s+/g, " ").slice(-180)
            const cur = tasksStore.get(t.id)
            // Не затираем текст этапа «сырым» фрагментом сразу после маркера.
            if (snippet) updateTask(t.id, { message: marker && cur ? (cur.message || snippet) : "…" + snippet })
          }
        } else if (part?.type === "tool" && part.state?.status === "running" && part.tool) {
          updateTask(t.id, { message: "Инструмент: " + part.tool })
        }
        return
      }
    }

  function stop(): void {
    try {
      if (server && !externalServer) {
        server.stop()
        log("server stopped")
      } else if (externalServer) {
        log("server is external — не останавливаю (другая копия opencode)")
      }
    } catch {}
    try {
      killTracker()
      log("geo tracker stopped")
    } catch {}
  }

  return { stop, handleEvent }
}

// Плагин opencode: обёртка над createSeoPanel (in-process клиент).
export default (async ({ client, directory }: any) => {
  if (client === undefined) {
    log("client is undefined — plugin only works inside a running opencode instance")
    return {}
  }
  // Развязанный режим: панель поднимает отдельный процесс (см. seo-panel/panel.ts),
  // а плагин в агенте только молчит — тогда рестарт панели не трогает агента.
  if (process.env.SEO_PANEL_EXTERNAL === "1") {
    log("panel is external (SEO_PANEL_EXTERNAL=1) — панель поднимает отдельный процесс")
    return {}
  }
  const panel = await createSeoPanel({ client, directory, projectDir: directory || process.cwd() })
  return {
    event: async ({ event }: any) => { try { await panel.handleEvent(event) } catch (e) { log("event handler failed: " + String(e)) } },
    dispose: async () => { try { panel.stop() } catch {} },
  }
}) satisfies Plugin
