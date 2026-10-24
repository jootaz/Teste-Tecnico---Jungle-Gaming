/** Thin metrics abstraction so use cases stay framework-free. */
export interface MetricsPort {
  transactionFinalized(kind: string, status: string): void;
  duplicateDetected(source: "idempotency" | "inbox"): void;
  pendingReferenceScheduled(): void;
  lockConflict(): void;
  reconciliationDivergence(): void;
}

export class NoopMetrics implements MetricsPort {
  transactionFinalized(): void {}
  duplicateDetected(): void {}
  pendingReferenceScheduled(): void {}
  lockConflict(): void {}
  reconciliationDivergence(): void {}
}
