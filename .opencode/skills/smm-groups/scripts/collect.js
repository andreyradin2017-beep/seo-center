"use strict"

// Оркестратор сбора по группам ВКонтакте / Telegram / MAX.
//
// Пример:
//   node collect.js \
//     --groups "https://vk.com/frontside, https://t.me/frontside, https://max.ru/frontside" \
//     --from 2026-08-01 --to 2026-09-25 \
//     --out /path/to/seo-results/vk.com_frontside_2026-09-25_120000 \
//     --project vk.com_frontside \
//     [--account 79990000000] [--headed]

const fs = require("node:fs")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const lib = require("./lib")

const COLLECTORS = {
  vk: require("./collect-vk"),
  tg: require("./collect-tg"),
  max: require("./collect-max"),
}

function projectFromOutDir(outDir) {
  const base = path.basename(outDir)
  return base.replace(/_\d{4}-\d{2}-\d{2}(_\d{6})?(_\d+)?$/, "") || "smm-groups"
}

function parseGroups(args) {
  const items = []
  if (args["groups-file"]) {
    const text = fs.readFileSync(args["groups-file"], "utf8")
    text.split(/\r?\n/).forEach((l) => l.trim() && items.push(l.trim()))
  }
  if (args.groups) {
    String(args.groups)
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((s) => items.push(s))
  }
  for (const p of args._) if (!p.startsWith("-")) items.push(p)
  return items
}

function runXlsx(rowsJson, fieldsJson, xlsxPath) {
  const script = path.join(__dirname, "build_xlsx.py")
  const candidates = ["python3", "python"]
  for (const bin of candidates) {
    const res = spawnSync(bin, [script, "--rows", rowsJson, "--fields", fieldsJson, "--out", xlsxPath], {
      stdio: "inherit",
    })
    if (res.error && res.error.code === "ENOENT") continue
    return res.status === 0
  }
  console.error("Python не найден — XLSX не сформирован. Установите python3 + openpyxl.")
  return false
}

async function main() {
  const args = lib.parseArgs(process.argv.slice(2))
  const config = lib.loadConfig()
  if (args.headed) config.headless = false

  const groupsRaw = parseGroups(args)
  if (!groupsRaw.length) {
    console.error("Не указаны группы. Используйте --groups \"url1,url2\" или --groups-file file.txt")
    process.exit(1)
  }

  const today = new Date()
  const defaultFrom = lib.toIsoDate(new Date(today.getTime() - 30 * 24 * 3600 * 1000))
  const from = args.from || defaultFrom
  const to = args.to || lib.toIsoDate(today)
  const outDir = path.resolve(args.out || process.cwd())
  fs.mkdirSync(outDir, { recursive: true })

  const groups = []
  for (const raw of groupsRaw) {
    const { platform } = lib.classifyGroup(raw)
    if (!platform) {
      console.error(`Пропуск «${raw}»: не удалось определить площадку (ожидается ВКонтакте / Telegram / MAX).`)
      continue
    }
    groups.push(Object.assign({ raw }, lib.normalizeGroup(raw, platform), { platform }))
  }
  if (!groups.length) {
    console.error("Не распознано ни одной группы ВКонтакте / Telegram / MAX.")
    process.exit(1)
  }

  console.error(`Групп к обработке: ${groups.length}; период: ${from} … ${to}`)
  console.error("Открываю браузер (профиль авторизации переиспользуется)…")
  const context = await lib.openBrowser(config, { headed: args.headed })
  const opts = { config, from, to, account: args.account || "", headless: config.headless !== false, headed: !!args.headed }

  const byPlatform = { vk: 0, tg: 0, max: 0 }
  const allRows = []
  try {
    for (const g of groups) {
      console.error(`\n→ ${g.platform.toUpperCase()}: ${g.url}`)
      try {
        const rows = await COLLECTORS[g.platform].collectGroup(context, g, opts)
        rows.forEach((r) => { r.platform = g.platform })
        allRows.push(...rows)
        byPlatform[g.platform] += rows.length
        console.error(`  собрано постов: ${rows.length}`)
      } catch (e) {
        console.error(`  ошибка сбора: ${e.message}`)
      }
    }
  } finally {
    await context.close().catch(() => {})
  }

  // Сортируем по дате (сначала новые), затем по группе.
  allRows.sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")))

  const rowsJson = path.join(outDir, "smm_rows.json")
  fs.writeFileSync(rowsJson, JSON.stringify(allRows, null, 2), "utf8")

  const project = args.project || projectFromOutDir(outDir)
  const xlsxPath = path.join(outDir, `SMM_группы_${project}.xlsx`)
  const fieldsJson = path.join(__dirname, "fields.json")
  const ok = runXlsx(rowsJson, fieldsJson, xlsxPath)

  console.error("\n────────── ИТОГ ──────────")
  console.error(`Всего постов: ${allRows.length} (VK ${byPlatform.vk}, TG ${byPlatform.tg}, MAX ${byPlatform.max})`)
  console.error(`JSON: ${rowsJson}`)
  if (ok) console.error(`XLSX: ${xlsxPath}`)
  process.exit(ok ? 0 : 3)
}

main().catch((e) => {
  console.error("Критическая ошибка: " + (e && e.stack ? e.stack : e))
  process.exit(1)
})
