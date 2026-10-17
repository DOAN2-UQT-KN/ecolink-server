"""AI-service background worker entrypoint.

Run:
  python -m app.worker
"""

from __future__ import annotations

import logging

from app.db.async_bridge import run_coro
from app.db.session import init_db
from app.queue.sqs_worker import run_worker

logger = logging.getLogger("ai-service.worker")


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    try:
        # Must share the worker loop with sync DB helpers (media hash upsert/lookup).
        run_coro(init_db())
    except Exception:  # noqa: BLE001
        logger.exception("init_db failed; continuing (tables may already exist)")
    run_worker()


if __name__ == "__main__":
    main()
