#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Контент-фабрика — генерация SEO-контента (бриф → статья → редактор).

Этапы:
  1. Бриф — на основе ключевого запроса формируется SEO-бриф (заголовок,
     описание, целевая аудитория, ключевые слова, структура H1–H3).
  2. Статья — генерируется полный текст статьи по брифу.
  3. Редактор (опционально) — проверка фактов, стиль, уменьшение ИИ-штампов.

Все вызовы LLM записываются в usage_ledger.py, защита от ранева — через
circuit_breaker.py.

Запуск:
  python3 content_factory.py --topics "запрос 1, запрос 2" --out-dir <папка>
  python3 content_factory.py --topics-file topics.txt --out-dir <папка>
  python3 content_factory.py --topics "запрос 1" --no-editor
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

try:
    from docx import Document
    from docx.shared import Pt, RGBColor
except ImportError:
    Document = None

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "tools" / "seo_collect"))
try:
    from usage_ledger import record as record_usage
    from circuit_breaker import is_blocked, record_retry, status as cb_status
except ImportError:
    def record_usage(*a, **k): pass
    def is_blocked(*a, **k): return False
    def record_retry(*a, **k): return 0
    def cb_status(*a, **k): return {"retries_today": 0, "max_retries": 10, "blocked": False}

UA = {"User-Agent": "Mozilla/5.0 (compatible; SEO-content-factory/1.0)"}

DEFAULT_MAX_ARTICLES = 5
DEFAULT_MAX_RETRIES = 3


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def clean_text(text: str) -> str:
    """Убирает лишние пробелы, пустые строки, маркдаун-заглушки."""
    if not text:
        return ""
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def call_llm(system_prompt: str, user_prompt: str, model: str = "gpt-4o-mini",
             max_tokens: int = 4000, temperature: float = 0.7,
             backend: str = "openai") -> str:
    """Вызов LLM с записью в леджер и защитой через circuit breaker."""
    if is_blocked():
        raise RuntimeError("Цепной выключатель сработал — превышен лимит повторов")

    try:
        # Попытка вызвать через OpenAI SDK если доступен
        try:
            from openai import OpenAI
            client = OpenAI()
            resp = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                max_tokens=max_tokens,
                temperature=temperature,
            )
            text = resp.choices[0].message.content or ""
            usage = getattr(resp, "usage", None)
            record_usage(
                model=model,
                backend=backend,
                input_tokens=getattr(usage, "prompt_tokens", 0) if usage else 0,
                output_tokens=getattr(usage, "completion_tokens", 0) if usage else 0,
                cost_usd=0.0,  # будет пересчитано отдельно при 필요
                metered=True,
                note=f"{backend}:{model}",
            )
            return clean_text(text)
        except ImportError:
            pass

        # Fallback: antropic
        try:
            import anthropic
            client = anthropic.Anthropic()
            resp = client.messages.create(
                model=model,
                max_tokens=max_tokens,
                temperature=temperature,
                system=system_prompt,
                messages=[{"role": "user", "content": user_prompt}],
            )
            text = "".join(b.text for b in resp.content if hasattr(b, "text"))
            record_usage(
                model=model,
                backend=backend,
                input_tokens=getattr(resp, "input_tokens", 0),
                output_tokens=getattr(resp, "output_tokens", 0),
                cost_usd=0.0,
                metered=True,
                note=f"{backend}:{model}",
            )
            return clean_text(text)
        except ImportError:
            pass

        raise RuntimeError("Ни один LLM-клиент (openai/anthropic) не доступен")

    except Exception as e:
        record_retry()
        raise RuntimeError(f"LLM вызов не удался: {e}")


def make_brief(topic: str, model: str = "gpt-4o-mini") -> dict:
    """Этап 1: сформировать SEO-бриф по теме."""
    system = """Ты опытный SEO-редактор. Составь краткий SEO-бриф по теме.
Верни строго JSON со следующими полями:
- slug: краткий URL-дружественный идентификатор (латиница, дефисы, без пробелов)
- title: заголовок статьи (H1), 50–70 символов
- description: мета-описание, 150–170 символов
- target_audience: кто целевая аудитория (одно предложение)
- primary_keyword: основной ключевой запрос
- secondary_keywords: список из 3–5 второстепенных запросов
- intent: намерение пользователя (informational / navigational / commercial / transactional)
- outline: список разделов H2–H3 с кратким описанием каждого (список объектов {heading, notes})
- word_count_target: целевой объём статьи (символов без пробелов)"""

    user = f"Тема: {topic}\n\nСоставь SEO-бриф."

    raw = call_llm(system, user, model=model, max_tokens=3000, temperature=0.5)
    try:
        brief = json.loads(raw)
    except json.JSONDecodeError:
        # Пробуем вытащить JSON из текста
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if m:
            brief = json.loads(m.group(0))
        else:
            brief = {
                "slug": re.sub(r"[^\w\s-]", "", topic.lower()).strip().replace(" ", "-")[:50],
                "title": topic,
                "description": "",
                "target_audience": "",
                "primary_keyword": topic,
                "secondary_keywords": [],
                "intent": "informational",
                "outline": [{"heading": "Введение", "notes": ""}],
                "word_count_target": 3000,
            }
    brief["topic"] = topic
    brief["created_at"] = now_iso()
    return brief


def make_article(brief: dict, model: str = "gpt-4o-mini") -> str:
    """Этап 2: сгенерировать статью по брифу."""
    outline_text = "\n".join(
        f"- {o.get('heading', '')}: {o.get('notes', '')}"
        for o in brief.get("outline", [])
    )

    system = """Ты опытный SEO-копирайтер. Напиши полную, уникальную, полезную статью по брифу.
Требования:
- Заголовок H1 уже дан, не повторяй его как отдельный заголовок в тексте.
- Используй структуру H2–H3 из брифа.
- Ключевые слова из sekundarnych запросов используй естественно.
- Объём: целевой из брифа (символов без пробелов).
- Без воды, без ИИ-штампов («в современном мире», «стоит отметить», «важно понимать»).
- Конкретика, цифры, факты. Живой деловой тон.
- Не используй термин «dofollow», «ссылочные облака», «регулярно перепроверять».
- Ссылки — полными URL, где уместно."""

    user = f"""БРИФ:
Тема: {brief.get('topic', '')}
Заголовок (H1): {brief.get('title', '')}
Основной запрос: {brief.get('primary_keyword', '')}
Второстепенные запросы: {', '.join(brief.get('secondary_keywords', []))}
Целевая аудитория: {brief.get('target_audience', '')}
Намерение: {brief.get('intent', 'informational')}
Целевой объём: {brief.get('word_count_target', 3000)} символов без пробелов

СТРУКТУРА (H2–H3):
{outline_text}

Напиши полную статью в формате Markdown (заголовки ##, ###, списки, абзацы)."""

    return call_llm(system, user, model=model, max_tokens=6000, temperature=0.7)


def edit_article(markdown_text: str, model: str = "gpt-4o-mini") -> str:
    """Этап 3: редакторская полировка — стиль, факты, удаление ИИ-штампов."""
    system = """Ты опытный редактор. Полируй текст статьи:
- Убери ИИ-штампы («в современном мире», «стоит отметить», «важно понимать», «незаменимый»).
- Исправь грамматику и пунктуацию.
- Сделай тон живым, деловым, без канцелярита.
- Сохрани структуру заголовков и смысл.
- Не меняй факты и ключевые слова.
- Верни только отредактированный текст в формате Markdown."""

    user = f"Текст статьи:\n\n{markdown_text}"
    return call_llm(system, user, model=model, max_tokens=6000, temperature=0.3)


def save_markdown(out_dir: Path, slug: str, content: str) -> Path:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    filepath = out_dir / f"{slug}.md"
    filepath.write_text(content, encoding="utf-8")
    return filepath


def save_docx(out_dir: Path, slug: str, title: str, content: str) -> Path | None:
    if Document is None:
        return None
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    filepath = out_dir / f"{slug}.docx"

    doc = Document()
    doc.styles["Normal"].font.size = Pt(11)
    doc.styles["Normal"].font.name = "Calibri"

    h1 = doc.add_heading(title, level=0)
    for run in h1.runs:
        run.font.size = Pt(24)
        run.font.color.rgb = RGBColor(0x33, 0x33, 0x33)

    # Парсим простой Markdown: ## H2, ### H3, обычный текст
    for line in content.split("\n"):
        line = line.strip()
        if not line:
            doc.add_paragraph()
            continue
        if line.startswith("## "):
            doc.add_heading(line[3:], level=1)
        elif line.startswith("### "):
            doc.add_heading(line[4:], level=2)
        elif line.startswith("- "):
            doc.add_paragraph(line[2:], style="List Bullet")
        elif line.startswith("* "):
            doc.add_paragraph(line[2:], style="List Bullet")
        else:
            doc.add_paragraph(line)

    filepath = out_dir / f"{slug}.docx"
    doc.save(filepath)
    return filepath


def process_topic(topic: str, out_dir: Path, model: str, with_editor: bool) -> dict:
    """Обработать одну тему: бриф → статья → редактор."""
    result = {
        "topic": topic,
        "slug": "",
        "title": "",
        "status": "pending",
        "error": None,
        "files": [],
    }

    try:
        # Этап 1: бриф
        brief = make_brief(topic, model=model)
        result["slug"] = brief.get("slug", "")
        result["title"] = brief.get("title", "")
        result["brief"] = brief

        # Этап 2: статья
        markdown = make_article(brief, model=model)

        # Этап 3: редактор (опционально)
        if with_editor:
            markdown = edit_article(markdown, model=model)

        # Сохраняем
        md_path = save_markdown(out_dir, result["slug"], markdown)
        result["files"].append(str(md_path))

        dx_path = save_docx(out_dir, result["slug"], result["title"], markdown)
        if dx_path:
            result["files"].append(str(dx_path))

        result["status"] = "published"
        print(f"  ✓ {topic} → {result['slug']}.md")

    except Exception as e:
        result["status"] = "failed"
        result["error"] = str(e)
        print(f"  ✗ {topic}: {e}")

    return result


def main():
    ap = argparse.ArgumentParser(description="Контент-фабрика: бриф → статья → редактор")
    ap.add_argument("--topics", default="", help="Темы через запятую")
    ap.add_argument("--topics-file", default="", help="Файл с темами (по одной на строку)")
    ap.add_argument("--out-dir", required=True, help="Папка для результатов")
    ap.add_argument("--model", default="gpt-4o-mini", help="Модель LLM")
    ap.add_argument("--no-editor", action="store_true", help="Без этапа редактора")
    ap.add_argument("--max-articles", type=int, default=DEFAULT_MAX_ARTICLES,
                    help="Максимальное количество статей за прогон")
    args = ap.parse_args()

    # Собираем темы
    topics = []
    if args.topics:
        topics.extend([t.strip() for t in args.topics.split(",") if t.strip()])
    if args.topics_file:
        with open(args.topics_file, encoding="utf-8") as f:
            topics.extend([t.strip() for t in f if t.strip()])

    if not topics:
        print("Не указаны темы. Используйте --topics или --topics-file.")
        return 1

    topics = topics[: args.max_articles]
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Контент-фабрика: {len(topics)} тем, редактор: {'нет' if args.no_editor else 'да'}")
    print(f"Модель: {args.model}, выход: {out_dir}")
    print()

    results = []
    for i, topic in enumerate(topics, 1):
        print(f"[{i}/{len(topics)}] {topic}")
        result = process_topic(topic, out_dir, args.model, with_editor=not args.no_editor)
        results.append(result)

    # Итог
    success = sum(1 for r in results if r["status"] == "published")
    failed = sum(1 for r in results if r["status"] == "failed")
    print()
    print(f"Готово: {success} опубликовано, {failed} ошибок из {len(results)}")
    for r in results:
        if r["status"] == "failed":
            print(f"  ✗ {r['topic']}: {r['error']}")
        else:
            print(f"  ✓ {r['topic']} → {', '.join(r['files'])}")

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
