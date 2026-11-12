"use strict"

// Сбор постов и метрик из публичных каналов/групп Telegram через веб-предпросмотр
// https://t.me/s/<channel> — без авторизации. Для закрытых каналов нужен вход
// (web.telegram.org), он в этом скрипте не выполняется автоматически.

const lib = require("./lib")

function extractTgPage() {
  const out = []
  const wraps = Array.from(document.querySelectorAll(".tgme_widget_message"))
  for (const w of wraps) {
    const dataPost = w.getAttribute("data-post")
    if (!dataPost) continue
    const timeEl = w.querySelector(".tgme_widget_message_date time, time")
    const viewsEl = w.querySelector(".tgme_widget_message_views")
    const textEl = w.querySelector(".tgme_widget_message_text")
    const repliesEl = w.querySelector(".tgme_widget_message_replies")
    const reactionEls = Array.from(w.querySelectorAll(".tgme_widget_message_reactions .tgme_widget_message_react"))
    const reactions = reactionEls.map((r) => (r.getAttribute("aria-label") || r.innerText || "").trim()).filter(Boolean)

    out.push({
      post_id: dataPost,
      date_raw: timeEl ? (timeEl.getAttribute("datetime") || timeEl.getAttribute("title") || timeEl.textContent) : null,
      views_raw: viewsEl ? (viewsEl.getAttribute("aria-label") || viewsEl.textContent) : null,
      replies_raw: repliesEl ? (repliesEl.getAttribute("aria-label") || repliesEl.textContent) : null,
      reactions_raw: reactions,
      text_raw: textEl ? textEl.innerText : "",
    })
  }
  return out
}

function minPostId(rows) {
  let min = null
  for (const r of rows) {
    const m = String(r.post_id).match(/\/(\d+)$/)
    if (!m) continue
    const id = parseInt(m[1], 10)
    if (!isNaN(id) && (min === null || id < min)) min = id
  }
  return min
}

async function collectGroup(context, group, opts) {
  const config = opts.config
  const page = await context.newPage()
  const rows = []
  const seen = new Set()
  try {
    const channel = group.id
    const maxPages = (config.tg && config.tg.maxBeforePages) || 40
    let before = null
    let stop = false

    for (let pageNo = 0; pageNo < maxPages && !stop; pageNo++) {
      const target = before ? `https://t.me/s/${channel}?before=${before}` : `https://t.me/s/${channel}`
      await page.goto(target, { waitUntil: "domcontentloaded" })
      await lib.sleep(1200)

      const hasPosts = await page.$(".tgme_widget_message")
      if (!hasPosts) {
        if (pageNo === 0) {
          console.error(`TG: @${channel} — публичных постов не найдено (возможно, закрытый канал).`)
        }
        break
      }

      const raw = await page.evaluate(extractTgPage)
      if (!raw.length) break

      let hasInPeriod = false
      for (const p of raw) {
        if (seen.has(p.post_id)) continue
        seen.add(p.post_id)
        const date = lib.parseDateLoose(p.date_raw)
        if (!lib.inPeriod(date, opts.from, opts.to)) continue
        hasInPeriod = true
        const totalReactions = (p.reactions_raw || []).reduce((acc, r) => acc + (lib.parseCount(r) || 0), 0) || null
        rows.push(lib.makeRow({
          platform: "tg",
          group: channel,
          group_url: `https://t.me/${channel}`,
          post_id: p.post_id,
          post_url: `https://t.me/${p.post_id}`,
          published_at: date,
          votes: totalReactions,
          comments: lib.parseCount(p.replies_raw),
          views_total: lib.parseCount(p.views_raw),
          hashtags: lib.extractHashtags(p.text_raw),
          text: lib.stripHashtags(p.text_raw),
        }))
      }

      const min = minPostId(raw)
      if (!min) break
      // Если на странице уже нет постов в периоде — дальше только более старые.
      if (!hasInPeriod) stop = true
      before = min
    }
  } finally {
    await page.close().catch(() => {})
  }
  return rows
}

module.exports = { collectGroup }
