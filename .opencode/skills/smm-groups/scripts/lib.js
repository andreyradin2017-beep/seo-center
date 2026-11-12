"use strict"

// Общие утилиты для сбора данных по группам ВКонтакте / Telegram / MAX.
// Скрипты запускаются через Playwright (Chromium), профиль авторизации
// переиспользуется между запусками (config.profileDir).

const fs = require("node:fs")
const path = require("node:path")

function loadConfig() {
  const p = path.join(__dirname, "config.json")
  const base = JSON.parse(fs.readFileSync(p, "utf8"))
  // Переменные окружения позволяют переопределять настройки без правки файла.
  if (process.env.SMM_HEADLESS === "1") base.headless = true
  if (process.env.SMM_HEADLESS === "0") base.headless = false
  if (process.env.SMM_MAX_SCROLLS) base.maxScrolls = parseInt(process.env.SMM_MAX_SCROLLS, 10) || base.maxScrolls
  return base
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) out[key] = true
      else { out[key] = next; i++ }
    } else out._.push(a)
  }
  return out
}

let playwright = null
function loadPlaywright() {
  if (playwright) return playwright
  try {
    playwright = require("playwright")
  } catch {
    console.error(
      "Не найден Playwright. Установите зависимости из корня проекта:\n" +
      "  npm i playwright\n" +
      "  npx playwright install chromium"
    )
    process.exit(2)
  }
  return playwright
}

async function openBrowser(config, opts = {}) {
  const { chromium } = loadPlaywright()
  const userDataDir = path.isAbsolute(config.profileDir)
    ? config.profileDir
    : path.join(__dirname, "..", config.profileDir)
  fs.mkdirSync(userDataDir, { recursive: true })
  const headless = opts.headed ? false : config.headless !== false
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    locale: config.locale || "ru-RU",
    timezoneId: config.timezoneId || "Europe/Moscow",
    viewport: { width: 1440, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  })
  context.setDefaultTimeout(30000)
  return context
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// Приводит подпись вида «1,2K», «12,3 тыс.», «1 234», «12 млн» к числу.
function parseCount(input) {
  if (input === null || input === undefined) return null
  let s = String(input).replace(/[\u00A0\u202F\u2009]/g, " ").trim()
  if (!s) return null
  if (/^(нет|нет данных|—|-|n\/a)$/i.test(s)) return null
  const lower = s.toLowerCase()
  let mult = 1
  let style = "ru" // ru: запятая — десятичная, точка — тысяч; en: наоборот
  if (/тыс|тысяч/.test(lower)) mult = 1000
  else if (/млн|миллион/.test(lower)) mult = 1e6
  else if (/млрд|миллиард/.test(lower)) mult = 1e9
  else if (/\d\s*k\b/i.test(lower)) { mult = 1000; style = "en" }
  else if (/\d\s*m\b/i.test(lower)) { mult = 1e6; style = "en" }
  else if (/\d\s*b\b/i.test(lower)) { mult = 1e9; style = "en" }

  let num = lower.replace(/[^\d.,]/g, "").replace(/^[.,]+|[.,]+$/g, "")
  if (!num) return null
  const hasDot = num.includes(".")
  const hasComma = num.includes(",")
  if (hasDot && hasComma) {
    if (style === "ru") num = num.replace(/\./g, "").replace(",", ".")
    else num = num.replace(/,/g, "")
  } else if (hasComma) {
    const after = num.length - num.lastIndexOf(",") - 1
    num = after === 3 ? num.replace(/,/g, "") : num.replace(",", ".")
  } else if (hasDot) {
    const after = num.length - num.lastIndexOf(".") - 1
    if (after === 3 && style === "ru") num = num.replace(/\./g, "")
  }
  const val = parseFloat(num)
  if (isNaN(val)) return null
  return Math.round(val * mult)
}

// Поиск чисел рядом с элементом по ключевым словам класса/атрибута.
function pickCount(root, patterns) {
  for (const sel of patterns) {
    const el = root.querySelector(sel)
    if (el) {
      const v = parseCount(el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent)
      if (v !== null) return v
    }
  }
  return null
}

function extractHashtags(text) {
  const tags = String(text || "").match(/#[\p{L}\p{N}_]+/gu) || []
  return tags.join(" ")
}

function stripHashtags(text) {
  return String(text || "")
    .replace(/#[\p{L}\p{N}_]+/gu, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

// Разбор даты в ISO (YYYY-MM-DD). Поддерживает ISO, dd.mm.yyyy, «сегодня/вчера».
function parseDateLoose(raw, now = new Date()) {
  const s = String(raw || "").trim()
  if (!s) return null
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const dmy = s.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})/)
  if (dmy) {
    let [, d, m, y] = dmy
    if (y.length === 2) y = "20" + y
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
  }
  const lower = s.toLowerCase()
  const day = new Date(now)
  if (lower.includes("сегодня")) return toIsoDate(day)
  if (lower.includes("вчера")) { day.setDate(day.getDate() - 1); return toIsoDate(day) }
  if (/\d{1,2}:\d{2}/.test(lower)) return toIsoDate(now)
  return null
}

function toIsoDate(d) {
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function inPeriod(isoDate, from, to) {
  if (!isoDate) return true // без даты не отбрасываем пост, отметим в отчёте
  if (from && isoDate < from) return false
  if (to && isoDate > to) return false
  return true
}

function classifyGroup(input) {
  const raw = String(input || "").trim()
  const lower = raw.toLowerCase()
  let platform = null
  if (/(^|[./])vk\.(com|ru)/.test(lower) || lower.startsWith("vk")) platform = "vk"
  else if (/(^|[./])t\.me|telegram\.me|telegram/.test(lower)) platform = "tg"
  else if (/(^|[./])max\.(ru|mail\.ru)/.test(lower)) platform = "max"
  return { platform, raw }
}

// Нормализует идентификатор группы и собирает URL площадки.
function normalizeGroup(input, platform) {
  let s = String(input || "").trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(s)) s = "https://" + s.replace(/^\/+/, "")
  const u = new URL(s)
  const seg = u.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean)
  const id = seg[0] || ""
  if (platform === "vk") return { url: `https://vk.com/${id}`, id: id || u.hostname, title: id || u.hostname }
  if (platform === "tg") return { url: `https://t.me/${id}`, id: id || u.hostname, title: id || u.hostname }
  if (platform === "max") return { url: `https://max.ru/${id}`, id: id || u.hostname, title: id || u.hostname }
  return { url: s, id: u.hostname, title: u.hostname }
}

function appendJsonLines(file, rows) {
  const data = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "")
  fs.appendFileSync(file, data, "utf8")
}

function makeRow(extra) {
  return Object.assign(
    {
      platform: null,
      group: null,
      group_url: null,
      post_id: null,
      post_url: null,
      published_at: null,
      likes: null,
      reposts: null,
      votes: null,
      comments: null,
      views_total: null,
      hashtags: null,
      text: null,
      collected_at: new Date().toISOString(),
    },
    extra
  )
}

module.exports = {
  loadConfig,
  parseArgs,
  loadPlaywright,
  openBrowser,
  sleep,
  parseCount,
  pickCount,
  extractHashtags,
  stripHashtags,
  parseDateLoose,
  toIsoDate,
  inPeriod,
  classifyGroup,
  normalizeGroup,
  appendJsonLines,
  makeRow,
}
