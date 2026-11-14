// GEO/AEO аудит (пункт 5.1): наличие навыка, скрипта и машинных правил.
import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

export const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const geoSkill = join(root, "skills", "geo-aeo-audit")

test("audit-rules.json содержит секцию geo_aeo", () => {
  const rules = JSON.parse(readFileSync(join(root, "rules", "audit-rules.json"), "utf8"))
  const g = rules.geo_aeo
  assert.ok(g, "ожидается ключ geo_aeo (без кириллических символов)")
  assert.ok(Array.isArray(g.ai_crawlers) && g.ai_crawlers.includes("GPTBot"))
  assert.ok(Array.isArray(g.required_jsonld_types) && g.required_jsonld_types.includes("BreadcrumbList"))
  assert.ok(Array.isArray(g.required_opengraph) && g.required_opengraph.includes("og:image"))
  assert.equal(g.required_https, true)
  assert.equal(g.required_llms_txt, true)
})

test("навык geo-aeo-audit содержит SKILL.md и скрипт", () => {
  assert.ok(existsSync(join(geoSkill, "SKILL.md")), "нет SKILL.md")
  const scripts = readdirSync(join(geoSkill, "scripts"))
  assert.ok(scripts.includes("geo_aeo_audit.py"), "нет scripts/geo_aeo_audit.py")
  const py = readFileSync(join(geoSkill, "scripts", "geo_aeo_audit.py"), "utf8")
  assert.match(py, /GEO\/AEO/, "скрипт не описывает GEO/AEO")
  // ключ правил скрипт должен брать как geo_aeo (не с кириллической е)
  assert.match(py, /geo_aeo/, "скрипт не ссылается на geo_aeo в правилах")
})

test("панель маппит пункт 5.1 на навык geo-aeo-audit", () => {
  const ui = readFileSync(join(root, "plugin", "seo-ui.ts"), "utf8")
  assert.match(ui, /"5\.1":\s*"geo-aeo-audit"/, "нет маппинга 5.1 → geo-aeo-audit")
  assert.match(ui, /data-point="5\.1" data-skill="geo-aeo-audit"/, "нет чекбокса 5.1 в форме")
})
