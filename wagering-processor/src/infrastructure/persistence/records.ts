import { EntitySchema } from "@mikro-orm/core";

/**
 * Persistence records are deliberately separate from domain entities:
 * the domain never sees ORM types, and repositories translate between
 * the two through the rehydrate factories.
 */

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallets",
  properties: {
    id: { type: "string", columnType: "uuid", primary: true },
    playerId: { type: "string", columnType: "uuid", fieldName: "player_id" },
    currency: { type: "string", columnType: "char(3)" },
    balanceAmount: { type: "string", columnType: "numeric(18,2)", fieldName: "balance_amount" },
    version: { type: "integer" },
    createdAt: { type: "Date", columnType: "timestamptz", fieldName: "created_at" },
    updatedAt: { type: "Date", columnType: "timestamptz", fieldName: "updated_at" },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status!: string;
  failureCode?: string;
  observedBalance?: string;
  referenceRetryAttempts!: number;
  nextReferenceRetryAt?: Date;
  createdAt!: Date;
  processedAt?: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transactions",
  properties: {
    id: { type: "string", columnType: "uuid", primary: true },
    providerId: { type: "string", fieldName: "provider_id" },
    externalTransactionId: { type: "string", fieldName: "external_transaction_id" },
    idempotencyKey: { type: "string", fieldName: "idempotency_key" },
    payloadHash: { type: "string", fieldName: "payload_hash" },
    walletId: { type: "string", columnType: "uuid", fieldName: "wallet_id" },
    playerId: { type: "string", columnType: "uuid", fieldName: "player_id" },
    roundId: { type: "string", fieldName: "round_id" },
    gameId: { type: "string", fieldName: "game_id" },
    kind: { type: "string" },
    amount: { type: "string", columnType: "numeric(18,2)" },
    currency: { type: "string", columnType: "char(3)" },
    referenceExternalTransactionId: {
      type: "string",
      fieldName: "reference_external_transaction_id",
      nullable: true,
    },
    referenceTransactionId: {
      type: "string",
      columnType: "uuid",
      fieldName: "reference_transaction_id",
      nullable: true,
    },
    status: { type: "string" },
    failureCode: { type: "string", fieldName: "failure_code", nullable: true },
    observedBalance: {
      type: "string",
      columnType: "numeric(18,2)",
      fieldName: "observed_balance",
      nullable: true,
    },
    referenceRetryAttempts: { type: "integer", fieldName: "reference_retry_attempts" },
    nextReferenceRetryAt: {
      type: "Date",
      columnType: "timestamptz",
      fieldName: "next_reference_retry_at",
      nullable: true,
    },
    createdAt: { type: "Date", columnType: "timestamptz", fieldName: "created_at" },
    processedAt: { type: "Date", columnType: "timestamptz", fieldName: "processed_at", nullable: true },
  },
});

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "string", columnType: "uuid", primary: true },
    walletId: { type: "string", columnType: "uuid", fieldName: "wallet_id" },
    transactionId: { type: "string", columnType: "uuid", fieldName: "transaction_id" },
    direction: { type: "string" },
    amount: { type: "string", columnType: "numeric(18,2)" },
    currency: { type: "string", columnType: "char(3)" },
    balanceBefore: { type: "string", columnType: "numeric(18,2)", fieldName: "balance_before" },
    balanceAfter: { type: "string", columnType: "numeric(18,2)", fieldName: "balance_after" },
    createdAt: { type: "Date", columnType: "timestamptz", fieldName: "created_at" },
  },
});

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "string", fieldName: "consumer_name", primary: true },
    messageId: { type: "string", fieldName: "message_id", primary: true },
    payloadHash: { type: "string", fieldName: "payload_hash" },
    receivedAt: { type: "Date", columnType: "timestamptz", fieldName: "received_at" },
    processedAt: { type: "Date", columnType: "timestamptz", fieldName: "processed_at", nullable: true },
  },
});

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: "outbox_messages",
  properties: {
    id: { type: "string", columnType: "uuid", primary: true },
    aggregateId: { type: "string", fieldName: "aggregate_id" },
    eventType: { type: "string", fieldName: "event_type" },
    payload: { type: "json", columnType: "jsonb" },
    occurredAt: { type: "Date", columnType: "timestamptz", fieldName: "occurred_at" },
    attempts: { type: "integer" },
    nextAttemptAt: { type: "Date", columnType: "timestamptz", fieldName: "next_attempt_at", nullable: true },
    publishedAt: { type: "Date", columnType: "timestamptz", fieldName: "published_at", nullable: true },
  },
});

export const ALL_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
