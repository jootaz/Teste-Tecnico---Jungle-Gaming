import type { ProcessPendingReferencesUseCase } from "../../application/use-cases/process-pending-references";
import type { Logger } from "../observability/logger";

/**
 * Scheduled worker that re-applies PENDING_REFERENCE transactions with
 * exponential backoff (the due time is computed by the domain). Safe to run
 * on every instance: rows are claimed with FOR UPDATE SKIP LOCKED.
 */
export class PendingReferenceWorker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly useCase: ProcessPendingReferencesUseCase,
    private readonly logger: Logger,
    private readonly pollIntervalMs = 1000,
    private readonly batchSize = 10,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(this.pollIntervalMs);
    this.logger.info({ worker: "pending-reference" }, "pending-reference worker started");
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
    this.logger.info({ worker: "pending-reference" }, "pending-reference worker stopped");
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.useCase
        .executeBatch(this.batchSize)
        .then((touched) => {
          this.scheduleNext(touched > 0 ? 0 : this.pollIntervalMs);
        })
        .catch((error) => {
          this.logger.error({ err: String(error) }, "pending-reference tick failed");
          this.scheduleNext(this.pollIntervalMs * 2);
        });
    }, delayMs);
  }
}
