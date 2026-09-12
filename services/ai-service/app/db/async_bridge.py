"""Run async coroutines from sync SQS-worker code on one shared event loop.

SQLAlchemy's async engine + asyncpg bind connections to the loop that created
them. Calling ``asyncio.run()`` repeatedly opens and closes a new loop each
time, so pooled connections raise
``Future ... attached to a different loop`` / ``another operation is in progress``.

Worker paths must reuse a single long-lived loop for all DB work.
"""

from __future__ import annotations

import asyncio
from typing import Any, Coroutine, Optional, TypeVar

T = TypeVar("T")

_loop: Optional[asyncio.AbstractEventLoop] = None


def get_worker_loop() -> asyncio.AbstractEventLoop:
    global _loop
    if _loop is None or _loop.is_closed():
        _loop = asyncio.new_event_loop()
        asyncio.set_event_loop(_loop)
    return _loop


def run_coro(coro: Coroutine[Any, Any, T]) -> T:
    """Block until ``coro`` finishes on the shared worker loop."""
    return get_worker_loop().run_until_complete(coro)
