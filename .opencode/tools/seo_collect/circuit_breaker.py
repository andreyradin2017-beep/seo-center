#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Цепной выключатель (circuit breaker) для защиты от ранева вызовов LLM.

Считает количество неудачных вызовов за сутки. Если превышен лимит —
все последующие вызовы блокируются до начала следующего суточного цикла.

Файл состояния: <data_dir>/budget/circuit_breaker.json
"""

import json
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path

DEFAULT_STATE_FILE = Path(__file__).resolve().parents[3] / ".opencode" / "data" / "budget" / "circuit_breaker.json"
DEFAULT_MAX_RETRIES = 10


def _ensure_dir(path: Path):
    path.mkdir(parents=True, exist_ok=True)


def _load_state(state_file: Path = None) -> dict:
    state_file = Path(state_file) if state_file else DEFAULT_STATE_FILE
    if not state_file.exists():
        return {"retries_today": 0, "day": _today_str()}
    try:
        with open(state_file, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {"retries_today": 0, "day": _today_str()}


def _save_state(state: dict, state_file: Path = None):
    state_file = Path(state_file) if state_file else DEFAULT_STATE_FILE
    _ensure_dir(state_file.parent)
    with open(state_file, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def _today_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _reset_if_new_day(state: dict) -> dict:
    """Если наступил новый день — сбрасывает счётчик."""
    if state.get("day") != _today_str():
        state["retries_today"] = 0
        state["day"] = _today_str()
    return state


def record_retry(state_file: Path = None) -> int:
    """Записывает один неудачный вызов. Возвращает текущее количество повторов за день."""
    state = _reset_if_new_day(_load_state(state_file))
    state["retries_today"] = state.get("retries_today", 0) + 1
    _save_state(state, state_file)
    return state["retries_today"]


def get_retries(state_file: Path = None) -> int:
    """Возвращает текущее количество повторов за день (без увеличения счётчика)."""
    state = _reset_if_new_day(_load_state(state_file))
    return state.get("retries_today", 0)


def is_blocked(state_file: Path = None, max_retries: int = DEFAULT_MAX_RETRIES) -> bool:
    """Возвращает True, если цепной выключатель сработал (лимит повторов превышен)."""
    return get_retries(state_file) >= max_retries


def reset(state_file: Path = None):
    """Сбрасывает счётчик повторов (ручной сброс)."""
    state = {"retries_today": 0, "day": _today_str()}
    _save_state(state, state_file)


def status(state_file: Path = None, max_retries: int = DEFAULT_MAX_RETRIES) -> dict:
    """Возвращает полный статус цепного выключателя."""
    state = _reset_if_new_day(_load_state(state_file))
    retries = state.get("retries_today", 0)
    return {
        "retries_today": retries,
        "max_retries": max_retries,
        "blocked": retries >= max_retries,
        "day": state.get("day", _today_str()),
        "remaining": max(0, max_retries - retries),
    }


if __name__ == "__main__":
    import sys
    state_file = sys.argv[1] if len(sys.argv) > 1 else None
    max_retries = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_MAX_RETRIES
    st = status(state_file, max_retries)
    print(f"Цепной выключатель:")
    print(f"  Повторов за день: {st['retries_today']} / {st['max_retries']}")
    print(f"  Осталось: {st['remaining']}")
    print(f"  Заблокирован: {'ДА' if st['blocked'] else 'НЕТ'}")
    print(f"  День: {st['day']}")
