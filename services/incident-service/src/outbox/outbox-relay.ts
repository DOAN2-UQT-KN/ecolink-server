import { Prisma, PrismaClient } from "@prisma/client";
import { GlobalStatus } from "../constants/status.enum";
import {
  type OutboxPublisher,
  SqsOutboxPublisher,
} from "./outbox-publisher";
import { CircuitBreaker } from "../resilience/circuit-breaker";

interface ClaimedRow {
  id: string;
  event_type: string;
  payload: Prisma.JsonValue;
  attempts: number;
  max_attempts: number;
}

interface RelayConfig {
  batchSize: number;
  pollIntervalMs: number;
  retryBaseMs: number;
  maxRetryDelayMs: number;
}

const ERROR_BACKOFF_MS = 2_000;

/**
 * Outbox relay: claims PENDING outbox rows (FOR UPDATE SKIP LOCKED so multiple
 * replicas don't double-process), publishes them onto the reward intake SQS
 * queue, and marks them COMPLETED. Delivery is at-least-once; the reward ledger
 * is idempotent.
 */
export class OutboxRelay {
  private isRunning = false;
  private isShuttingDown = false;
  private readonly config: RelayConfig;
  private publisher: OutboxPublisher | null;
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly prisma: PrismaClient,
    publisher?: OutboxPublisher,
    breaker?: CircuitBreaker,
  ) {
    this.publisher = publisher ?? null;
    this.config = {
      batchSize: Number(process.env.OUTBOX_RELAY_BATCH_SIZE ?? 20),
      pollIntervalMs: Number(process.env.OUTBOX_RELAY_POLL_INTERVAL_MS ?? 2000),
      retryBaseMs: Number(process.env.OUTBOX_RELAY_RETRY_BASE_MS ?? 30_000),
      maxRetryDelayMs: Number(
        process.env.OUTBOX_RELAY_MAX_RETRY_DELAY_MS ?? 900_000,
      ),
    };
    // Guards the downstream publish path: if the reward intake (SQS) keeps
    // failing, the breaker opens so the relay stops claiming rows. Events stay
    // PENDING and are retried after the cooldown instead of every event burning
    // its own attempts against a dependency that is globally down.
    this.breaker =
      breaker ??
      new CircuitBreaker(
        {
          failureThreshold: Number(
            process.env.OUTBOX_BREAKER_FAILURE_THRESHOLD ?? 5,
          ),
          openDurationMs: Number(process.env.OUTBOX_BREAKER_OPEN_MS ?? 30_000),
          successThreshold: Number(
            process.env.OUTBOX_BREAKER_SUCCESS_THRESHOLD ?? 2,
          ),
        },
        undefined,
        "outbox->reward",
      );
  }

  /** Lazily build the SQS publisher so tests can run without queue env. */
  private getPublisher(): OutboxPublisher {
    if (!this.publisher) {
      this.publisher = new SqsOutboxPublisher();
    }
    return this.publisher;
  }

  /** Current downstream circuit state — useful for health/metrics endpoints. */
  getCircuitState(): string {
    return this.breaker.getState();
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log("[OutboxRelay] started");
    void this.pollLoop();
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;
    while (this.isRunning) {
      await sleep(100);
    }
    console.log("[OutboxRelay] stopped");
  }

  private async pollLoop(): Promise<void> {
    this.isRunning = true;
    try {
      while (!this.isShuttingDown) {
        // Circuit OPEN: skip claiming entirely so rows stay PENDING (no rows
        // stranded in INPROCESS) until the cooldown lets a trial through.
        if (!this.breaker.canRequest()) {
          await sleep(this.config.pollIntervalMs);
          continue;
        }
        // In HALF_OPEN only a single trial event is claimed to probe recovery.
        const limit =
          this.breaker.getState() === "HALF_OPEN" ? 1 : this.config.batchSize;
        const claimed = await this.claimBatch(limit);
        if (claimed.length === 0) {
          await sleep(this.config.pollIntervalMs);
          continue;
        }
        for (let i = 0; i < claimed.length; i += 1) {
          // The breaker may trip mid-batch; release the not-yet-delivered rows
          // back to PENDING so they are re-claimed on a later (healthy) cycle.
          if (this.isShuttingDown || !this.breaker.canRequest()) {
            await this.releaseToPending(claimed.slice(i).map((r) => r.id));
            break;
          }
          await this.deliver(claimed[i]);
        }
      }
    } catch (err) {
      console.error(
        `[OutboxRelay] loop error: ${(err as Error).message}`,
      );
      await sleep(ERROR_BACKOFF_MS);
    } finally {
      this.isRunning = false;
      if (!this.isShuttingDown) void this.pollLoop();
    }
  }

  /** Atomically lock + mark a batch as in-process so replicas don't collide. */
  private async claimBatch(
    limit: number = this.config.batchSize,
  ): Promise<ClaimedRow[]> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<ClaimedRow[]>(Prisma.sql`
        SELECT id, event_type, payload, attempts, max_attempts
        FROM outbox_events
        WHERE status = ${GlobalStatus._STATUS_PENDING} AND run_after <= now()
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `);
      if (rows.length === 0) return [];
      await tx.outboxEvent.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { status: GlobalStatus._STATUS_INPROCESS },
      });
      return rows;
    });
  }

  /** Return claimed-but-undelivered rows to PENDING (e.g. circuit tripped). */
  private async releaseToPending(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.outboxEvent.updateMany({
      where: { id: { in: ids } },
      data: { status: GlobalStatus._STATUS_PENDING },
    });
  }

  private async deliver(row: ClaimedRow): Promise<void> {
    try {
      // Publisher routes by eventType (e.g. REPORT_SUBMITTED → AI queue;
      // green-point events → reward intake). Downstream workers route by jobType.
      await this.getPublisher().publish({
        id: row.id,
        eventType: row.event_type,
        payload: row.payload,
      });
      await this.prisma.outboxEvent.update({
        where: { id: row.id },
        data: {
          status: GlobalStatus._STATUS_COMPLETED,
          processedAt: new Date(),
          lastError: null,
        },
      });
      this.breaker.onSuccess();
    } catch (err) {
      await this.handleFailure(row, err);
      this.breaker.onFailure();
    }
  }

  private async handleFailure(row: ClaimedRow, err: unknown): Promise<void> {
    const attempts = row.attempts + 1;
    const message = err instanceof Error ? err.message : String(err);

    if (attempts >= row.max_attempts) {
      await this.prisma.outboxEvent.update({
        where: { id: row.id },
        data: {
          status: GlobalStatus._STATUS_FAILED,
          attempts,
          lastError: message,
          processedAt: new Date(),
        },
      });
      console.error(
        `[OutboxRelay] event ${row.id} (${row.event_type}) FAILED after ${attempts} attempts: ${message}`,
      );
      return;
    }

    const delayMs = Math.min(
      this.config.maxRetryDelayMs,
      this.config.retryBaseMs * 2 ** (attempts - 1),
    );
    await this.prisma.outboxEvent.update({
      where: { id: row.id },
      data: {
        status: GlobalStatus._STATUS_PENDING,
        attempts,
        lastError: message,
        runAfter: new Date(Date.now() + delayMs),
      },
    });
    console.warn(
      `[OutboxRelay] event ${row.id} (${row.event_type}) retry ${attempts} in ${delayMs}ms: ${message}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
