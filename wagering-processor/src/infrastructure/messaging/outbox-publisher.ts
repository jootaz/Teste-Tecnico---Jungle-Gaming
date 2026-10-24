import type { EventPublisher, UnitOfWork } from "../../application/ports";
import { isTransientPgError } from "../../application/retry";
import type { Logger } from "../observability/logger";
import type { Metrics } from "../observability/metrics";

/**
 * Transactional-outbox publisher.
 *
 * Each tick claims due, unpublished rows with FOR UPDATE SKIP LOCKED inside
 * a SQL transaction, publishes them to SQS and marks them published before
 * committing. Multiple instances run this loop concurrently without stepping
 * on each other. If the process dies between publish and commit the row stays
 * unpublished and another instance re-publishes it — delivery is
 * at-least-once and consumers deduplicate by eventId.
 */
export class OutboxPublisher {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly pollIntervalMs = 500,
    private readonly batchSize = 20,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
    this.logger.info({ worker: "outbox-publisher" }, "outbox publisher started");
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
    this.logger.info({ worker: "outbox-publisher" }, "outbox publisher stopped");
  }

  /** Runs one batch; exposed for integration tests. */
  async tick(): Promise<number> {
    return this.uow.run(async (repos) => {
      const due = await repos.outbox.findDueForUpdate(new Date(), this.batchSize);
      let published = 0;
      for (const message of due) {
        try {
          await this.publisher.publish(message.payload);
          message.markPublished(new Date());
          this.metrics.outboxPublished.inc();
          this.metrics.outboxLag.observe((Date.now() - message.occurredAt.getTime()) / 1000);
          published += 1;
        } catch (error) {
          message.scheduleRetry(new Date());
          this.metrics.outboxFailures.inc();
          this.logger.warn(
            { eventId: message.id, eventType: message.eventType, attempts: message.attempts, err: String(error) },
            "outbox publish failed, rescheduled",
          );
        }
        await repos.outbox.update(message);
      }
      return published;
    });
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.tick()
        .then((published) => {
          // Drain quickly while there is work; back off when idle.
          this.scheduleNext(published > 0 ? 0 : this.pollIntervalMs);
        })
        .catch((error) => {
          const level = isTransientPgError(error) ? "warn" : "error";
          this.logger[level]({ err: String(error) }, "outbox tick failed");
          this.scheduleNext(this.pollIntervalMs * 2);
        });
    }, delayMs);
  }
}
