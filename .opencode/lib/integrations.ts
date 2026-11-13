export type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<any> }>

export type IntegrationKind = "psi" | "gsc" | "webmaster" | "metrika" | "wordstat"

export interface IntegrationResult {
  ok: boolean
  kind: IntegrationKind
  summary: string
  data?: any
  error?: string
}

const TIMEOUT_MS = 15_000
const PSI_URL = "https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed"
const GSC_URL = "https://www.googleapis.com/webmasters/v3"
const WEBMASTER_URL = "https://api.webmaster.yandex.net/v4"
const METRIKA_URL = "https://api-metrika.yandex.net/stat/v1/data"
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function fail(kind: IntegrationKind, summary: string, error: string): IntegrationResult {
  return { ok: false, kind, summary, error }
}

function num(value: any): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function dateError(value: string): string | null {
  if (!ISO_DATE.test(value)) return `Некорректная дата "${value}": нужен формат YYYY-MM-DD`
  // toISOString отсекает 31 февраля и другие несуществующие дни.
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return `Некорректная дата "${value}": нужен формат YYYY-MM-DD`
  return null
}

function auth(prefix: string, token: string): Record<string, string> {
  return { Authorization: `${prefix} ${token}` }
}

async function readBody(response: { text(): Promise<string> }): Promise<string> {
  try {
    return (await response.text()).replace(/\s+/g, " ").trim().slice(0, 200)
  } catch {
    return ""
  }
}

async function apiJson(fetchImpl: FetchLike | undefined, kind: IntegrationKind, summary: string, url: string, init?: any): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const doFetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    const response = await doFetch(url, { ...init, signal: controller.signal })
    if (!response.ok) {
      const body = await readBody(response)
      return fail(kind, summary, `HTTP ${response.status}${body ? `: ${body}` : ""}`)
    }
    try {
      return { ok: true, json: await response.json() }
    } catch {
      return fail(kind, summary, "Ответ API не является JSON")
    }
  } catch (error) {
    const aborted = (error as any)?.name === "AbortError"
    return fail(kind, summary, aborted ? `Превышен таймаут ${TIMEOUT_MS / 1000} с` : `Сетевая ошибка: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

export async function psiCheck(input: { url: string; apiKey?: string; strategy?: "mobile" | "desktop"; fetchImpl?: FetchLike }): Promise<IntegrationResult> {
  const strategy = input.strategy ?? "mobile"
  const summary = `PageSpeed Insights (${strategy}): ${input.url}`
  if (!input.url) return fail("psi", summary, "Укажите URL страницы")
  if (!input.apiKey) return fail("psi", summary, "Нужен API-ключ Google: передайте apiKey или задайте GOOGLE_PSI_API_KEY (без ключа PSI отвечает 403)")

  const params = new URLSearchParams({ url: input.url, key: input.apiKey, strategy })
  for (const category of ["performance", "seo", "accessibility", "best-practices"]) params.append("category", category)

  const response = await apiJson(input.fetchImpl, "psi", summary, `${PSI_URL}?${params.toString()}`, { method: "GET" })
  if (!response.ok) return response
  const json = response.json

  const categories = json?.lighthouseResult?.categories ?? {}
  const audit = (id: string) => num(json?.lighthouseResult?.audits?.[id]?.numericValue)
  const score = (id: string) => {
    const value = num(categories[id]?.score)
    return value === null ? null : Math.round(value * 100)
  }
  const percentile = (key: string) => num(json?.loadingExperience?.metrics?.[key]?.percentile)

  const auditRounded = (id: string, digits = 0) => {
    const value = audit(id)
    return value === null ? null : round(value, digits)
  }
  const lab = {
    lcpMs: auditRounded("largest-contentful-paint"),
    cls: auditRounded("cumulative-layout-shift", 3),
    inpMs: auditRounded("interaction-to-next-paint"),
    tbtMs: auditRounded("total-blocking-time"),
  }
  const scores = {
    performance: score("performance"),
    seo: score("seo"),
    accessibility: score("accessibility"),
    bestPractices: score("best-practices"),
  }

  // PSI отдаёт CLS в сотых долях, в отличие от лабораторного значения.
  const fieldCls = percentile("CUMULATIVE_LAYOUT_SHIFT_SCORE")
  const field = {
    lcpMs: percentile("LARGEST_CONTENTFUL_PAINT_MS"),
    cls: fieldCls === null ? null : round(fieldCls / 100, 3),
    inpMs: percentile("INTERACTION_TO_NEXT_PAINT"),
  }
  const hasField = field.lcpMs !== null || field.cls !== null || field.inpMs !== null

  const parts = [
    `performance ${scores.performance ?? "—"}`,
    `SEO ${scores.seo ?? "—"}`,
    lab.lcpMs === null ? null : `LCP ${round(lab.lcpMs / 1000, 1)} с`,
    lab.cls === null ? null : `CLS ${lab.cls}`,
    lab.inpMs !== null ? `INP ${lab.inpMs} мс` : lab.tbtMs !== null ? `TBT ${lab.tbtMs} мс` : null,
  ].filter((part): part is string => Boolean(part))

  return {
    ok: true,
    kind: "psi",
    summary: `PageSpeed Insights (${strategy}): ${parts.join(", ")}`,
    data: { url: json?.id ?? input.url, strategy, scores, lab, field: hasField ? field : null },
  }
}

export async function gscSites(input: { token: string; fetchImpl?: FetchLike }): Promise<IntegrationResult> {
  const summary = "Search Console: список сайтов"
  const response = await apiJson(input.fetchImpl, "gsc", summary, `${GSC_URL}/sites`, { headers: auth("Bearer", input.token) })
  if (!response.ok) return response

  const sites = (response.json?.siteEntry ?? []).map((site: any) => ({
    siteUrl: String(site?.siteUrl ?? ""),
    permissionLevel: String(site?.permissionLevel ?? ""),
  }))
  return { ok: true, kind: "gsc", summary: `Search Console: ${sites.length} сайтов`, data: { sites } }
}

export async function gscQueries(input: { token: string; siteUrl: string; startDate: string; endDate: string; limit?: number; fetchImpl?: FetchLike }): Promise<IntegrationResult> {
  const summary = `Search Console: топ запросов ${input.startDate}..${input.endDate}`
  const invalidDate = dateError(input.startDate) ?? dateError(input.endDate)
  if (invalidDate) return fail("gsc", summary, invalidDate)

  const url = `${GSC_URL}/sites/${encodeURIComponent(input.siteUrl)}/searchAnalytics/query`
  const body = JSON.stringify({ startDate: input.startDate, endDate: input.endDate, dimensions: ["query"], rowLimit: input.limit ?? 100 })
  const response = await apiJson(input.fetchImpl, "gsc", summary, url, {
    method: "POST",
    headers: { ...auth("Bearer", input.token), "Content-Type": "application/json" },
    body,
  })
  if (!response.ok) return response

  const queries = (response.json?.rows ?? []).map((row: any) => ({
    query: String(row?.keys?.[0] ?? ""),
    clicks: num(row?.clicks) ?? 0,
    impressions: num(row?.impressions) ?? 0,
    ctr: round(num(row?.ctr) ?? 0, 4),
    position: round(num(row?.position) ?? 0, 1),
  }))
  return { ok: true, kind: "gsc", summary: `Search Console: ${queries.length} запросов ${input.startDate}..${input.endDate}`, data: { queries } }
}

export async function webmasterHosts(input: { token: string; fetchImpl?: FetchLike }): Promise<IntegrationResult> {
  const summary = "Яндекс.Вебмастер: список хостов"
  const userResponse = await apiJson(input.fetchImpl, "webmaster", summary, `${WEBMASTER_URL}/user/`, { headers: auth("OAuth", input.token) })
  if (!userResponse.ok) return userResponse
  const userId = userResponse.json?.user_id
  if (userId === undefined || userId === null) return fail("webmaster", summary, "Не удалось получить user_id из ответа Вебмастера")

  const response = await apiJson(input.fetchImpl, "webmaster", summary, `${WEBMASTER_URL}/user/${userId}/hosts/`, { headers: auth("OAuth", input.token) })
  if (!response.ok) return response

  const hosts = (response.json?.hosts ?? []).map((host: any) => ({
    hostId: String(host?.host_id ?? ""),
    url: String(host?.unicode_host_url ?? host?.ascii_host_url ?? ""),
    verified: Boolean(host?.verified),
  }))
  return { ok: true, kind: "webmaster", summary: `Яндекс.Вебмастер: ${hosts.length} хостов`, data: { hosts } }
}

export async function webmasterIndexing(input: { token: string; hostId: string; fetchImpl?: FetchLike }): Promise<IntegrationResult> {
  const summary = `Яндекс.Вебмастер: история индексации ${input.hostId}`
  const userResponse = await apiJson(input.fetchImpl, "webmaster", summary, `${WEBMASTER_URL}/user/`, { headers: auth("OAuth", input.token) })
  if (!userResponse.ok) return userResponse
  const userId = userResponse.json?.user_id
  if (userId === undefined || userId === null) return fail("webmaster", summary, "Не удалось получить user_id из ответа Вебмастера")

  const dateTo = new Date().toISOString().slice(0, 10)
  const dateFrom = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const url = `${WEBMASTER_URL}/user/${userId}/hosts/${encodeURIComponent(input.hostId)}/indexing/history?date_from=${dateFrom}&date_to=${dateTo}`
  const response = await apiJson(input.fetchImpl, "webmaster", summary, url, { headers: auth("OAuth", input.token) })
  if (!response.ok) return response

  const points = (response.json?.history ?? [])
    .map((point: any) => ({
      date: String(point?.date ?? "").slice(0, 10),
      searchablePages: num(point?.searchable_pages_count) ?? 0,
      excludedPages: num(point?.excluded_pages_count) ?? 0,
    }))
    .filter((point: any) => point.date)
    .sort((a: any, b: any) => a.date.localeCompare(b.date))

  const latest = points.at(-1) ?? null
  const first = points[0]
  const change = latest && first && points.length > 1 ? latest.searchablePages - first.searchablePages : 0
  const trend = change > 0 ? "up" : change < 0 ? "down" : "flat"
  const trendText = trend === "up" ? "рост" : trend === "down" ? "снижение" : "без изменений"

  return {
    ok: true,
    kind: "webmaster",
    summary: `Яндекс.Вебмастер ${input.hostId}: ${latest ? `${latest.searchablePages} страниц в индексе` : "нет данных"}, тренд ${trendText}`,
    data: { hostId: input.hostId, latest, trend, change, points },
  }
}

export async function metrikaSummary(input: { token: string; counterId: string; startDate: string; endDate: string; fetchImpl?: FetchLike }): Promise<IntegrationResult> {
  const summary = `Яндекс.Метрика ${input.counterId}: ${input.startDate}..${input.endDate}`
  const invalidDate = dateError(input.startDate) ?? dateError(input.endDate)
  if (invalidDate) return fail("metrika", summary, invalidDate)

  const params = new URLSearchParams({
    ids: input.counterId,
    metrics: "ym:s:visits,ym:s:users,ym:s:pageviews",
    date1: input.startDate,
    date2: input.endDate,
    accuracy: "full",
  })
  const response = await apiJson(input.fetchImpl, "metrika", summary, `${METRIKA_URL}?${params.toString()}`, { headers: auth("OAuth", input.token) })
  if (!response.ok) return response

  const json = response.json
  const totals = Array.isArray(json?.totals?.[0]) ? json.totals[0] : Array.isArray(json?.data?.[0]?.metrics) ? json.data[0].metrics : []
  const data = {
    counterId: input.counterId,
    startDate: input.startDate,
    endDate: input.endDate,
    visits: num(totals[0]) ?? 0,
    users: num(totals[1]) ?? 0,
    pageviews: num(totals[2]) ?? 0,
  }
  return {
    ok: true,
    kind: "metrika",
    summary: `Яндекс.Метрика ${input.counterId}: визиты ${data.visits}, пользователи ${data.users}, просмотры ${data.pageviews}`,
    data,
  }
}

const WORDSTAT_URL = "https://search-api.cloud.yandex.net/v2/wordstat/phrases"

export async function wordstatFrequency(input: {
  apiKey: string
  folderId: string
  phrases: string[]
  region?: number | string
  fetchImpl?: FetchLike
}): Promise<IntegrationResult> {
  if (!input.apiKey) return fail("wordstat", "Яндекс.Вордстат: частотность фраз", "Нужен API-ключ Yandex Cloud (Search API): передайте apiKey")
  if (!input.folderId) return fail("wordstat", "Яндекс.Вордстат: частотность фраз", "Нужен идентификатор каталога Yandex Cloud: передайте folderId")
  if (!input.phrases || !Array.isArray(input.phrases) || input.phrases.length === 0) return fail("wordstat", "Яндекс.Вордстат: частотность фраз", "Укажите хотя бы одну фразу")

  const summary = `Яндекс.Вордстат: частотность ${input.phrases.length} фраз`

  const body = JSON.stringify({
    phrases: input.phrases,
    ...(input.region !== undefined ? { region: input.region } : {}),
  })

  const response = await apiJson(input.fetchImpl, "wordstat", summary, WORDSTAT_URL, {
    method: "POST",
    headers: {
      ...auth("Api-Key", input.apiKey),
      "Content-Type": "application/json",
      "x-folder-id": input.folderId,
    },
    body,
  })
  if (!response.ok) return response

  const json = response.json
  const phrases = Array.isArray(json?.phrases) ? json.phrases : Array.isArray(json?.results) ? json.results : []
  const data = phrases.map((p: any) => ({
    phrase: String(p?.phrase ?? p?.query ?? ""),
    frequency: num(p?.frequency ?? p?.total ?? p?.count) ?? 0,
    region: p?.region ?? null,
  }))

  return {
    ok: true,
    kind: "wordstat",
    summary: `Яндекс.Вордстат: получено ${data.length} фраз`,
    data: { phrases: data },
  }
}
