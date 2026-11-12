"use strict"

// Сбор постов и метрик из групп/пабликов ВКонтакте.
// Публичные счётчики (лайки, репосты, комментарии, просмотры, голоса опросов) видны всем.

const lib = require("./lib")

async function ensureLoggedIn(page, url, opts) {
  await page.goto(url, { waitUntil: "domcontentloaded" })
  await lib.sleep(1500)
  const loginForm = await page.$("#login, .login_form, form[action*='login']")
  if (!loginForm) return true
  if (opts.account) {
    // Предзаполняем логин, чтобы пользователю осталось ввести пароль/код.
    try {
      const field = await page.$("input[name='email'], input[name='login'], #login input[type='text']")
      if (field) await field.fill(String(opts.account))
    } catch {}
  }
  if (opts.headless) {
    console.error("VK: требуется авторизация — запустите с флагом --headed и войдите в окне браузера.")
    return false
  }
  console.error("VK: войдите в открытом окне браузера (ожидание до 3 минут)…")
  try {
    await page.waitForSelector("#login, .login_form, form[action*='login']", { state: "detached", timeout: 180000 })
    return true
  } catch {
    return false
  }
}

async function expandWall(page, config, from) {
  let lastHeight = 0
  let stale = 0
  for (let i = 0; i < config.maxScrolls; i++) {
    const h = await page.evaluate(() => document.body.scrollHeight)
    if (h === lastHeight) stale++
    else stale = 0
    lastHeight = h
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await lib.sleep(config.scrollPauseMs)
    if (stale >= 2) break
    // Прекращаем прокрутку, когда догруженные посты уже старше периода.
    if (from) {
      const oldest = await page.evaluate(() => {
        const times = Array.from(document.querySelectorAll("time"))
          .map((t) => t.getAttribute("datetime") || t.getAttribute("title") || "")
          .filter(Boolean)
          .map((s) => (s.match(/^\d{4}-\d{2}-\d{2}/) ? s.slice(0, 10) : null))
          .filter(Boolean)
          .sort()
        return times[0] || null
      })
      if (oldest && oldest < from) break
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  await lib.sleep(400)
}

function extractFromDom() {
  const pick = (card, selectors) => {
    for (const sel of selectors) {
      const el = card.querySelector(sel)
      if (!el) continue
      const v = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim()
      if (v) return v
    }
    return null
  }
  const out = []
  const seen = new Set()
  const cards = Array.from(document.querySelectorAll('.wall_post, [data-post-id], .post, .wall_item'))
  for (const card of cards) {
    const linkEl = card.querySelector('a[href*="/wall"]')
    const href = linkEl ? linkEl.href : null
    if (!href) continue
    const m = href.match(/wall(-?\d+_\d+)/)
    if (!m) continue
    const postId = m[1]
    if (seen.has(postId)) continue
    seen.add(postId)

    const timeEl = card.querySelector("time")
    let date = timeEl ? (timeEl.getAttribute("datetime") || timeEl.getAttribute("title") || timeEl.textContent) : null
    if (!date) date = pick(card, ['a[href*="/wall"] .rel_date', ".rel_date", ".PostHeaderSubtitle__link"])

    const textEl = card.querySelector(".wall_post_text, .PostText, [class*='post_text']")
    const text = textEl ? textEl.innerText : (card.innerText || "").slice(0, 4000)

    out.push({
      post_id: postId.replace("_", "_"),
      post_url: href.split("?")[0],
      date_raw: date,
      text_raw: text,
      likes_raw: pick(card, [".PostButtonReactions__title", ".like_count", "[class*='like_count']", "a[href*='like'] .PostButtonReactions__title"]),
      comments_raw: pick(card, [".replies", "[class*='replies']", "a[href*='reply'] .count", ".post_replies"]),
      reposts_raw: pick(card, [".share_count", "[class*='share_count']", "a[href*='share'] .count"]),
      views_raw: pick(card, [".post_views", "[class*='views']", ".views_count"]),
      votes_raw: pick(card, ["[class*='poll'] [class*='votes']", ".poll_votes"]),
    })
  }
  return out
}

async function collectGroup(context, group, opts) {
  const config = opts.config
  const page = await context.newPage()
  const rows = []
  try {
    if (!(await ensureLoggedIn(page, group.url, opts))) return rows
    await expandWall(page, config, opts.from)
    const raw = await page.evaluate(extractFromDom)

    for (const p of raw) {
      const date = lib.parseDateLoose(p.date_raw)
      if (!lib.inPeriod(date, opts.from, opts.to)) continue
      const text = lib.stripHashtags(p.text_raw)
      const row = lib.makeRow({
        platform: "vk",
        group: group.title,
        group_url: group.url,
        post_id: p.post_id,
        post_url: p.post_url,
        published_at: date,
        likes: lib.parseCount(p.likes_raw),
        reposts: lib.parseCount(p.reposts_raw),
        votes: lib.parseCount(p.votes_raw),
        comments: lib.parseCount(p.comments_raw),
        views_total: lib.parseCount(p.views_raw),
        hashtags: lib.extractHashtags(p.text_raw),
        text: text,
      })
      rows.push(row)
    }
  } finally {
    await page.close().catch(() => {})
  }
  return rows
}

module.exports = { collectGroup }
