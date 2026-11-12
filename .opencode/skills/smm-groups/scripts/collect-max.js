"use strict"

// Сбор постов из каналов MAX (max.ru). MAX — новая платформа, публичная
// веб-версия отдаёт минимум статистики, поэтому собираем то, что доступно:
// ссылку, дату, текст и хештеги. Остальные метрики остаются пустыми.

const lib = require("./lib")

function extractMaxPage() {
  const out = []
  const seen = new Set()
  const anchors = Array.from(document.querySelectorAll('a[href*="/post/"], a[href*="post="], [data-post-id]'))
  for (const a of anchors) {
    const href = a.href || a.getAttribute("data-post-id") || ""
    const m = String(href).match(/(?:\/post\/|\bpost[=/])([A-Za-z0-9._-]+)/)
    if (!m) continue
    const id = m[1]
    if (seen.has(id)) continue
    seen.add(id)

    const card = a.closest("article, .post, [class*='post'], li, div") || a
    const timeEl = card.querySelector("time")
    const textEl = card.querySelector("[class*='text'], .post__text, p")
    const viewsEl = card.querySelector("[class*='view'], [class*='counter']")

    out.push({
      post_id: id,
      post_url: a.href || href,
      date_raw: timeEl ? (timeEl.getAttribute("datetime") || timeEl.getAttribute("title") || timeEl.textContent) : null,
      views_raw: viewsEl ? viewsEl.textContent : null,
      text_raw: textEl ? textEl.innerText : (card.innerText || "").slice(0, 2000),
    })
  }
  return out
}

async function collectGroup(context, group, opts) {
  const config = opts.config
  const page = await context.newPage()
  const rows = []
  try {
    await page.goto(group.url, { waitUntil: "domcontentloaded" })
    await lib.sleep(2000)
    for (let i = 0; i < (config.maxScrolls || 20); i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await lib.sleep(config.scrollPauseMs || 1200)
    }
    const raw = await page.evaluate(extractMaxPage)
    for (const p of raw) {
      const date = lib.parseDateLoose(p.date_raw)
      if (!lib.inPeriod(date, opts.from, opts.to)) continue
      rows.push(lib.makeRow({
        platform: "max",
        group: group.id,
        group_url: group.url,
        post_id: p.post_id,
        post_url: p.post_url,
        published_at: date,
        views_total: lib.parseCount(p.views_raw),
        hashtags: lib.extractHashtags(p.text_raw),
        text: lib.stripHashtags(p.text_raw),
      }))
    }
    if (!rows.length) {
      console.error(`MAX: ${group.url} — посты на странице не распознаны (веб-версия MAX может требовать приложение).`)
    }
  } catch (e) {
    console.error(`MAX: ошибка при сборе ${group.url}: ${e.message}`)
  } finally {
    await page.close().catch(() => {})
  }
  return rows
}

module.exports = { collectGroup }
