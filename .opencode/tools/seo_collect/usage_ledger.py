#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Учёт расхода токенов LLM (usage ledger).

Записывает каждый вызов LLM в JSONL-файл:
  <data_dir>/budget/usage.jsonl

Поля строки:
  ts, model, backend, input_tokens, output_tokens,
  cache_read_tokens, cache_creation_tokens, cost_usd, metered, note

Предоставляет функции:
  record(...) — записать один вызов
  today_summary(days=1) — сводка за последние N дней
  total_cost(days=1) — общая стоимость за последние N дней
"""

import json
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path

DEFAULT_DATA_DIR = Path(__file__).resolve().parents[3] / ".opencode" / "data" / "budget"
LEDGER_FILE = DEFAULT_DATA_DIR / "usage.jsonl"


def _ensure_dir(path: Path):
    path.mkdir(parents=True, exist_ok=True)


def record(model: str, backend: str, input_tokens: int, output_tokens: int,
           cache_read_tokens: int = 0, cache_creation_tokens: int = 0,
           cost_usd: float = 0.0, metered: bool = True, note: str = "",
           ledger_file: str | Path = None):
    """Записать один вызов LLM в леджер."""
    ledger = Path(ledger_file) if ledger_file else LEDGER_FILE
    _ensure_dir(ledger.parent)
    row = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "model": model,
        "backend": backend,
        "input_tokens": int(input_tokens),
        "output_tokens": int(output_tokens),
        "cache_read_tokens": int(cache_read_tokens),
        "cache_creation_tokens": int(cache_creation_tokens),
        "cost_usd": float(cost_usd),
        "metered": bool(metered),
        "note": note,
    }
    with open(ledger, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def _iter_rows(ledger_file: Path):
    if not ledger_file.exists():
        return
    with open(ledger_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def today_summary(days: int = 1, ledger_file: str | Path = None) -> dict:
    """Сводка расходов за последние `days` дней."""
    ledger = Path(ledger_file) if ledger_file else LEDGER_FILE
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    calls = 0
    input_tokens = 0
    output_tokens = 0
    cache_read_tokens = 0
    cache_creation_tokens = 0
    cost_usd = 0.0
    metered_calls = 0
    models = {}
    backends = {}

    for row in _iter_rows(ledger):
        try:
            ts = datetime.fromisoformat(row["ts"])
        except (ValueError, KeyError):
            continue
        if ts < cutoff:
            continue
        calls += 1
        input_tokens += row.get("input_tokens", 0)
        output_tokens += row.get("output_tokens", 0)
        cache_read_tokens += row.get("cache_read_tokens", 0)
        cache_creation_tokens += row.get("cache_creation_tokens", 0)
        cost_usd += row.get("cost_usd", 0.0)
        if row.get("metered", True):
            metered_calls += 1
        m = row.get("model", "unknown")
        models[m] = models.get(m, 0) + 1
        b = row.get("backend", "unknown")
        backends[b] = backends.get(b, 0) + 1

    return {
        "days": days,
        "calls": calls,
        "metered_calls": metered_calls,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_tokens": cache_read_tokens,
        "cache_creation_tokens": cache_creation_tokens,
        "cost_usd": round(cost_usd, 4),
        "models": models,
        "backends": backends,
    }


def total_cost(days: int = 1, ledger_file: str | Path = None) -> float:
    """Общая стоимость за последние `days` дней."""
    return today_summary(days, ledger_file)["cost_usd"]


if __name__ == "__main__":
    import sys
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    summary = today_summary(days)
    print(f"Расход за последние {days} дн.:")
    print(f"  Вызовы: {summary['calls']} (платные: {summary['metered_calls']})")
    print(f"  Входящих токенов: {summary['input_tokens']}")
    print(f"  Исходящих токенов: {summary['output_tokens']}")
    print(f"  Кэш чтения: {summary['cache_read_tokens']}")
    print(f"  Кэш записи: {summary['cache_creation_tokens']}")
    print(f"  Стоимость: ${summary['cost_usd']:.4f}")
    if summary["models"]:
        print("  По моделям:")
        for m, c in sorted(summary["models"].items(), key=lambda x: -x[1]):
            print(f"    {m}: {c}")
    if summary["backends"]:
        print("  По бэкендам:")
        for b, c in sorted(summary["backends"].items(), key=lambda x: -x[1]):
            print(f"    {b}: {c}")
