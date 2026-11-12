// Генераторы технических SEO-файлов: robots.txt, sitemap.xml, JSON-LD.
// Правила из методики центра: в robots обязателен Disallow: /*?, микроразметка —
// только типы из справочника, даты ISO 8601, у контента @id/headline/text.

export interface RobotsInput {
  sitemaps?: string[]
  disallow?: string[]
  allow?: string[]
  userAgent?: string
  cleanParams?: boolean
}

const cleanLine = (s: unknown) => String(s ?? "").replace(/\s+/g, "").trim()

export function buildRobots(input: RobotsInput = {}): string {
  const ua = cleanLine(input.userAgent) || "*"
  const sitemaps = (input.sitemaps || []).map((s) => String(s).trim()).filter((s) => /^https?:\/\//i.test(s))
  const disallow = (input.disallow || []).map(cleanLine).filter(Boolean)
  const allow = (input.allow || []).map(cleanLine).filter(Boolean)
  const lines = [
    "# Сгенерировано SEO-центром. Проверьте правила перед публикацией.",
    `User-agent: ${ua}`,
    "Disallow:",
  ]
  for (const a of allow) lines.push(`Allow: ${a}`)
  for (const d of disallow) lines.push(`Disallow: ${d}`)
  // Обязательное правило методики: закрываем параметры от дублей.
  if (input.cleanParams !== false) lines.push("Disallow: /*?")
  if (sitemaps.length) {
    lines.push("")
    for (const s of sitemaps) lines.push(`Sitemap: ${s}`)
  }
  return lines.join("\n") + "\n"
}

export interface SitemapInput {
  lastmod?: string
  changefreq?: string
  priority?: string
}

const XML_ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }
export const xmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => XML_ESCAPE[c])

export function normalizeUrlList(urls: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of urls) {
    let u: URL
    try { u = new URL(String(raw).trim()) } catch { continue }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue
    u.hash = ""
    const value = u.toString()
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

export function buildSitemap(urls: string[], input: SitemapInput = {}): string {
  const list = normalizeUrlList(urls).slice(0, 50_000)
  const lastmod = input.lastmod && isIsoDate(input.lastmod) ? input.lastmod : ""
  const changefreq = ["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"].includes(String(input.changefreq))
    ? String(input.changefreq) : ""
  const priority = input.priority && /^(0(\.\d+)?|1(\.0+)?)$/.test(String(input.priority)) ? String(input.priority) : ""
  const rows = list.map((u) => {
    const parts = [`    <loc>${xmlEscape(u)}</loc>`]
    if (lastmod) parts.push(`    <lastmod>${lastmod}</lastmod>`)
    if (changefreq) parts.push(`    <changefreq>${changefreq}</changefreq>`)
    if (priority) parts.push(`    <priority>${priority}</priority>`)
    return `  <url>\n${parts.join("\n")}\n  </url>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join("\n")}\n</urlset>\n`
}

// Первый столбец CSV (Метатеги_<хост>.csv, выгрузка URL) → список URL.
export function urlsFromCsv(csv: string): string[] {
  const urls: string[] = []
  for (const line of String(csv).split(/\r?\n/)) {
    const cell = line.split(/[;,\t]/)[0].replace(/^"|"$/g, "").trim()
    if (/^https?:\/\//i.test(cell)) urls.push(cell)
  }
  return normalizeUrlList(urls)
}

export const JSONLD_REQUIRED: Record<string, string[]> = {
  Article: ["headline", "image", "datePublished", "author"],
  NewsArticle: ["headline", "image", "datePublished", "author"],
  BlogPosting: ["headline", "image", "datePublished", "author"],
  TechArticle: ["headline", "datePublished", "author"],
  Organization: ["name", "url"],
  LocalBusiness: ["name", "address", "url"],
  Store: ["name", "address", "url"],
  MedicalOrganization: ["name", "address", "url"],
  BreadcrumbList: ["itemListElement"],
  Product: ["name", "offers"],
  Service: ["name", "provider"],
  FAQPage: ["mainEntity"],
  QAPage: ["mainEntity"],
  HowTo: ["name", "step"],
  VideoObject: ["name", "description", "thumbnailUrl", "uploadDate"],
  Recipe: ["name", "recipeIngredient", "recipeInstructions"],
  Review: ["itemReviewed", "reviewRating", "author"],
}

export function isIsoDate(value: unknown): boolean {
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/.test(String(value ?? ""))
}

const ISO_DATE_FIELDS = new Set(["datePublished", "dateModified", "uploadDate", "dateCreated", "startDate", "endDate"])

export interface JsonLdResult { ok: boolean; errors: string[]; json: string; script: string }

export function buildJsonLd(type: string, data: Record<string, any>): JsonLdResult {
  const errors: string[] = []
  const t = String(type || "").trim()
  if (!JSONLD_REQUIRED[t]) errors.push(`Тип «${t || "—"}» не из справочника поддерживаемых типов.`)
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, errors: [...errors, "Данные должны быть JSON-объектом."], json: "", script: "" }
  }
  const required = JSONLD_REQUIRED[t] || []
  for (const field of required) {
    const v = data[field]
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)
    if (empty) errors.push(`Нет обязательного поля: ${field}.`)
  }
  for (const [k, v] of Object.entries(data)) {
    if (ISO_DATE_FIELDS.has(k) && v && !isIsoDate(v)) errors.push(`Поле ${k} должно быть датой ISO 8601 (YYYY-MM-DD или с временем и зоной).`)
  }
  if (t === "BreadcrumbList" && Array.isArray(data.itemListElement)) {
    data.itemListElement.forEach((item: any, i: number) => {
      if (!item || typeof item !== "object") return
      if (!Number.isFinite(Number(item.position))) errors.push(`itemListElement[${i}]: нет position.`)
      if (!item.name) errors.push(`itemListElement[${i}]: нет name.`)
      if (i < data.itemListElement.length - 1 && !item.item) errors.push(`itemListElement[${i}]: нет item (ссылки), кроме последнего.`)
    })
  }
  const payload = { "@context": "https://schema.org", "@type": t, ...data }
  const json = JSON.stringify(payload, null, 2)
  return { ok: errors.length === 0, errors, json, script: `<script type="application/ld+json">\n${json}\n</script>` }
}

export function jsonLdTemplate(type: string): Record<string, any> {
  const base: Record<string, any> = { "@id": "https://example.com/page#main" }
  switch (type) {
    case "Article": case "NewsArticle": case "BlogPosting": case "TechArticle":
      return { ...base, headline: "Заголовок статьи", image: ["https://example.com/image.jpg"], datePublished: "2026-01-01", dateModified: "2026-01-01", author: { "@type": "Person", name: "Автор" }, publisher: { "@type": "Organization", name: "Компания" }, mainEntityOfPage: "https://example.com/page" }
    case "BreadcrumbList":
      return { itemListElement: [{ "@type": "ListItem", position: 1, name: "Главная", item: "https://example.com/" }, { "@type": "ListItem", position: 2, name: "Текущая страница" }] }
    case "FAQPage": case "QAPage":
      return { mainEntity: [{ "@type": "Question", name: "Вопрос?", acceptedAnswer: { "@type": "Answer", text: "Ответ." } }] }
    case "Product":
      return { name: "Товар", image: ["https://example.com/image.jpg"], offers: { "@type": "Offer", price: "1000", priceCurrency: "RUB", availability: "https://schema.org/InStock" } }
    default:
      return { ...base, name: "Название" }
  }
}
