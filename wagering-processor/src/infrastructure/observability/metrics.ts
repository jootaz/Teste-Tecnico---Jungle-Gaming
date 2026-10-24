import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { MetricsPort } from "../../application/metrics-port";

/**
 * Prometheus metrics covering, at minimum: transactions by status, detected
 * duplicates, retries, DLQ traffic, lock conflicts, outbox lag and
 * processing latency.
 */
export class Metrics implements MetricsPort {
  readonly registry = new Registry();

  readonly transactionsFinalized = new Counter({
    name: "wager_transactions_finalized_total",
    help: "Transactions that reached a terminal status",
    labelNames: ["kind", "status"] as const,
    registers: [this.registry],
  });

  readonly duplicates = new Counter({
    name: "wager_duplicates_detected_total",
    help: "Duplicates caught by persistent idempotency or inbox",
    labelNames: ["source"] as const,
    registers: [this.registry],
  });

  readonly pendingReference = new Counter({
    name: "wager_pending_reference_scheduled_total",
    help: "Transactions parked waiting for their reference",
    registers: [this.registry],
  });

  readonly lockConflicts = new Counter({
    name: "wager_lock_conflicts_total",
    help: "Concurrent-insert and lock conflicts resolved by retry",
    registers: [this.registry],
  });

  readonly reconciliationDivergences = new Counter({
    name: "wallet_reconciliation_divergence_total",
    help: "Reconciliations where ledger and stored balance diverged",
    registers: [this.registry],
  });

  readonly sqsMessages = new Counter({
    name: "sqs_messages_total",
    help: "SQS consumer outcomes",
    labelNames: ["result"] as const, // processed | duplicate | retried | dlq
    registers: [this.registry],
  });

  readonly outboxPublished = new Counter({
    name: "outbox_published_total",
    help: "Outbox messages successfully published",
    registers: [this.registry],
  });

  readonly outboxFailures = new Counter({
    name: "outbox_publish_failures_total",
    help: "Outbox publish attempts that failed and were rescheduled",
    registers: [this.registry],
  });

  readonly outboxLag = new Histogram({
    name: "outbox_lag_seconds",
    help: "Delay between event occurrence and publication",
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 300],
    registers: [this.registry],
  });

  readonly processingLatency = new Histogram({
    name: "wager_processing_latency_seconds",
    help: "Latency of transaction submission handling",
    labelNames: ["source"] as const, // http | sqs | worker
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  // ---- MetricsPort ---------------------------------------------------------

  transactionFinalized(kind: string, status: string): void {
    this.transactionsFinalized.inc({ kind, status });
  }

  duplicateDetected(source: "idempotency" | "inbox"): void {
    this.duplicates.inc({ source });
  }

  pendingReferenceScheduled(): void {
    this.pendingReference.inc();
  }

  lockConflict(): void {
    this.lockConflicts.inc();
  }

  reconciliationDivergence(): void {
    this.reconciliationDivergences.inc();
  }
}
