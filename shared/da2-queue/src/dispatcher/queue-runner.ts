import type { QueueRouteConfig } from "../config/queue-config";
import type { QueueWorker } from "../core/queue-worker";
import { BackgroundJobDispatcher } from "./background-job-dispatcher";

/**
 * Manages queue registration and worker lifecycle for all routes.
 *
 * Each service creates ONE shared instance and uses it to:
 *   1. Register all routes (queues + worker factories) at startup.
 *   2. Start all workers when the worker entry point boots.
 *
 * The dispatcher is exposed so services can inject it into their
 * API layer for enqueueing without reaching into concrete queues.
 */
export class QueueRunner {
  private readonly _dispatcher = new BackgroundJobDispatcher();
  private readonly routeWorkers = new Map<string, QueueWorker[]>();
  private started = false;
  private stopping: Promise<void> | null = null;

  constructor(private readonly routes: QueueRouteConfig[] = []) {
    for (const route of routes) {
      this.registerRoute(route);
    }
  }

  /** Register a single route. Safe to call before startAll(). */
  registerRoute(route: QueueRouteConfig): void {
    const queue = route.createQueue();
    this._dispatcher.register(route.jobType, queue);

    const workers = route.createWorkers(queue, route.store);
    this.routeWorkers.set(route.jobType, workers);
  }

  /** Start all registered workers. Call once from the worker entry point. */
  startAll(): void {
    if (this.started) return;
    this.started = true;

    for (const workers of this.routeWorkers.values()) {
      for (const worker of workers) {
        worker.start();
      }
    }

    const totalWorkers = [...this.routeWorkers.values()].reduce(
      (sum, w) => sum + w.length,
      0,
    );
    console.log(
      `[QueueRunner] ${totalWorkers} worker(s) started across ${this.routeWorkers.size} route(s)`,
    );
  }

  /**
   * Stop all registered workers.
   *
   * Safe to call multiple times; concurrent calls are coalesced.
   */
  async stopAll(): Promise<void> {
    if (!this.started) return;
    if (this.stopping) return this.stopping;

    this.stopping = (async () => {
      const allWorkers = [...this.routeWorkers.values()].flat();
      await Promise.all(allWorkers.map((w) => w.stop()));
      this.started = false;
      this.stopping = null;
      console.log(
        `[QueueRunner] ${allWorkers.length} worker(s) stopped across ${this.routeWorkers.size} route(s)`,
      );
    })();

    return this.stopping;
  }

  /** Shared dispatcher for enqueueing from the API. */
  get dispatcher(): BackgroundJobDispatcher {
    return this._dispatcher;
  }
}
