#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Файловый lock на очередь аудита.

Предотвращает одновременный запуск двух процессов панели/агента, которые
могли бы одновременно брать задания из очереди аудита (.queue.json).

Использование:
    with queue_lease.acquire(lock_path) as acquired:
        if not acquired:
            print("другой процесс уже работает — выхожу")
            return 0
        # работаем с очередью

    # или:
    if queue_lease.try_acquire(lock_path):
        try:
            # работаем с очередью
        finally:
            queue_lease.release(lock_path)
"""

import fcntl
import os
import time
from pathlib import Path


DEFAULT_LOCK_FILE = Path(__file__).resolve().parents[3] / ".opencode" / "data" / "queue.lock"


class QueueLease:
    """Неблокирующий файловый lock на очередь аудита."""

    def __init__(self, lock_file: str | Path = None):
        self.lock_file = Path(lock_file) if lock_file else DEFAULT_LOCK_FILE
        self._fd = None

    def acquire(self, lock_file: str | Path = None, blocking: bool = False,
                timeout: float = 5.0) -> bool:
        """Попытаться захватить lock.

        Args:
            lock_file: путь к файлу lock
            blocking: если True — ждать до timeout секунд
            timeout: максимальное время ожидания в секундах (только для blocking=True)

        Returns:
            True если lock захвачен, False если не удалось
        """
        lock_file = Path(lock_file) if lock_file else self.lock_file
        lock_file.parent.mkdir(parents=True, exist_ok=True)

        if blocking:
            return self._acquire_blocking(lock_file, timeout)
        else:
            return self._acquire_nonblocking(lock_file)

    def _acquire_nonblocking(self, lock_file: Path) -> bool:
        try:
            self._fd = os.open(str(lock_file), os.O_CREAT | os.O_RDWR, 0o644)
            fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except (OSError, BlockingIOError):
            return False

    def _acquire_blocking(self, lock_file: Path, timeout: float) -> bool:
        lock_file.parent.mkdir(parents=True, exist_ok=True)
        self._fd = os.open(str(lock_file), os.O_CREAT | os.O_RDWR, 0o644)
        start = time.time()
        while True:
            try:
                fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return True
            except (OSError, BlockingIOError):
                if time.time() - start >= timeout:
                    self.close()
                    return False
                time.sleep(0.1)

    def release(self, lock_file: str | Path = None):
        """Освободить lock."""
        if self._fd is not None:
            try:
                fcntl.flock(self._fd, fcntl.LOCK_UN)
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None

    def __enter__(self):
        if not self.acquire():
            raise BlockingIOError("не удалось захватить lock очереди аудита")
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.release()


# Module-level convenience functions for simple use cases

_acquire_lock = QueueLease()


def acquire(lock_file: str | Path = None, blocking: bool = False,
            timeout: float = 5.0) -> bool:
    """Захватить lock очереди аудита."""
    return _acquire_lock.acquire(lock_file, blocking, timeout)


def release(lock_file: str | Path = None):
    """Освободить lock очереди аудита."""
    _acquire_lock.release(lock_file)


def is_locked(lock_file: str | Path = None) -> bool:
    """Проверить, захвачен ли lock (попытка захватить и сразу освободить)."""
    lock = QueueLease(lock_file)
    if lock.acquire(blocking=False):
        lock.release()
        return False
    return True


if __name__ == "__main__":
    import sys
    lock_file = sys.argv[1] if len(sys.argv) > 1 else str(DEFAULT_LOCK_FILE)
    if acquire(lock_file):
        print(f"Lock захвачен: {lock_file}")
        release(lock_file)
        print("Lock освобождён")
    else:
        print(f"Lock уже занят: {lock_file}")
