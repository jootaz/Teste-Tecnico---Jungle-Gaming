export interface AppConfig {
  port: number;
  databaseUrl: string;
  sqs: {
    endpoint: string;
    region: string;
    transactionsQueue: string;
    transactionsDlq: string;
    eventsQueue: string;
    waitTimeSeconds: number;
    maxReceiveCount: number;
  };
  workers: {
    consumerEnabled: boolean;
    outboxEnabled: boolean;
    pendingReferenceEnabled: boolean;
    outboxPollIntervalMs: number;
    outboxBatchSize: number;
    pendingReferencePollIntervalMs: number;
    pendingReferenceMaxAttempts: number;
  };
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw ? Number.parseInt(raw, 10) : fallback;
  return Number.isFinite(value) ? value : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  return raw === undefined ? fallback : raw !== "false" && raw !== "0";
}

export function loadConfig(): AppConfig {
  return {
    port: int("PORT", 3000),
    databaseUrl: process.env.DATABASE_URL ?? "postgresql://wagering:wagering@localhost:5432/wagering",
    sqs: {
      endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
      region: process.env.SQS_REGION ?? "us-east-1",
      transactionsQueue: process.env.SQS_TRANSACTIONS_QUEUE ?? "wager-transactions.fifo",
      transactionsDlq: process.env.SQS_TRANSACTIONS_DLQ ?? "wager-transactions-dlq.fifo",
      eventsQueue: process.env.SQS_EVENTS_QUEUE ?? "wager-events",
      waitTimeSeconds: int("CONSUMER_WAIT_TIME_SECONDS", 5),
      maxReceiveCount: int("CONSUMER_MAX_RECEIVE_COUNT", 5),
    },
    workers: {
      consumerEnabled: bool("CONSUMER_ENABLED", true),
      outboxEnabled: bool("OUTBOX_PUBLISHER_ENABLED", true),
      pendingReferenceEnabled: bool("PENDING_REFERENCE_WORKER_ENABLED", true),
      outboxPollIntervalMs: int("OUTBOX_POLL_INTERVAL_MS", 500),
      outboxBatchSize: int("OUTBOX_BATCH_SIZE", 20),
      pendingReferencePollIntervalMs: int("PENDING_REFERENCE_POLL_INTERVAL_MS", 1000),
      pendingReferenceMaxAttempts: int("PENDING_REFERENCE_MAX_ATTEMPTS", 10),
    },
  };
}
