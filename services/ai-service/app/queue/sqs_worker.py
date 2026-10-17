"""SQS long-poll worker for ai-service background jobs."""

from __future__ import annotations

import logging
import signal
import time
from typing import Optional

import boto3
from botocore.client import BaseClient

from app.config import settings
from app.queue.envelope import BackgroundJobEnvelope
from app.queue.handlers import dispatch

logger = logging.getLogger("ai-service.queue.sqs_worker")


class SqsWorker:
    def __init__(
        self,
        *,
        queue_url: Optional[str] = None,
        client: Optional[BaseClient] = None,
        wait_time_seconds: int = 20,
        max_messages: int = 5,
    ) -> None:
        self.queue_url = (queue_url or settings.sqs_ai_analysis_queue_url).strip()
        if not self.queue_url:
            raise ValueError(
                "SQS_AI_ANALYSIS_QUEUE_URL must be configured for the AI worker"
            )
        self.wait_time_seconds = wait_time_seconds
        self.max_messages = max_messages
        self._running = True
        if client is not None:
            self.sqs = client
        else:
            kwargs: dict = {"region_name": settings.aws_region}
            if settings.aws_sqs_endpoint:
                kwargs["endpoint_url"] = settings.aws_sqs_endpoint
            kwargs["aws_access_key_id"] = settings.aws_access_key_id
            kwargs["aws_secret_access_key"] = settings.aws_secret_access_key
            self.sqs = boto3.client("sqs", **kwargs)

    def stop(self) -> None:
        self._running = False

    def run_forever(self) -> None:
        logger.info("SQS worker polling %s", self.queue_url)
        while self._running:
            try:
                self.poll_once()
            except Exception:
                logger.exception("SQS poll loop error; backing off")
                time.sleep(2)

    def poll_once(self) -> int:
        resp = self.sqs.receive_message(
            QueueUrl=self.queue_url,
            MaxNumberOfMessages=self.max_messages,
            WaitTimeSeconds=self.wait_time_seconds,
            VisibilityTimeout=60,
        )
        messages = resp.get("Messages") or []
        for message in messages:
            self._handle_message(message)
        return len(messages)

    def _handle_message(self, message: dict) -> None:
        receipt = message.get("ReceiptHandle")
        body = message.get("Body") or ""
        try:
            envelope = BackgroundJobEnvelope.parse(body)
        except (ValueError, TypeError, Exception) as err:
            logger.error("Invalid envelope; deleting poison message: %s", err)
            if receipt:
                self.sqs.delete_message(
                    QueueUrl=self.queue_url, ReceiptHandle=receipt
                )
            return

        try:
            dispatch(envelope)
        except ValueError as err:
            # Unknown jobType: log and delete so the poller does not crash / retry forever.
            logger.warning(
                "Skipping message jobId=%s: %s",
                getattr(envelope, "job_id", "?"),
                err,
            )
            if receipt:
                self.sqs.delete_message(
                    QueueUrl=self.queue_url, ReceiptHandle=receipt
                )
            return
        except Exception:
            logger.exception(
                "Handler failed jobId=%s jobType=%s; leaving message for retry",
                envelope.job_id,
                envelope.job_type,
            )
            return

        if receipt:
            self.sqs.delete_message(QueueUrl=self.queue_url, ReceiptHandle=receipt)


def run_worker() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    worker = SqsWorker()

    def _shutdown(signum: int, _frame: object) -> None:
        logger.info("Received signal %s; shutting down", signum)
        worker.stop()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)
    worker.run_forever()
