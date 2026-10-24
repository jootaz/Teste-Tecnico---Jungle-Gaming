import type { Wallet } from "../domain/entities/wallet";
import type { WagerTransaction } from "../domain/entities/wager-transaction";
import type { WalletLedgerEntry } from "../domain/entities/wallet-ledger-entry";
import type { InboxMessage } from "../domain/entities/inbox-message";
import type { OutboxMessage } from "../domain/entities/outbox-message";
import type { Money } from "../domain/value-objects/money";

/** Thrown by repositories when a database uniqueness constraint fires. */
export class UniqueConstraintViolation extends Error {
  constructor(public readonly constraintName: string) {
    super(`unique constraint violated: ${constraintName}`);
    this.name = "UniqueConstraintViolation";
  }
}

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE — serializes concurrent work on the same wallet. */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  update(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  insert(transaction: WagerTransaction): Promise<void>;
  update(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByProviderAndIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** Whether a PROCESSED reversal (REFUND or ROLLBACK) of the given reference already exists. */
  existsProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** Due PENDING_REFERENCE rows, locked with FOR UPDATE SKIP LOCKED. */
  findDuePendingReferenceForUpdate(now: Date, limit: number): Promise<WagerTransaction[]>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor?: string;
}

export interface LedgerAggregate {
  credits: Money;
  debits: Money;
  count: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  findByWallet(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage>;
  aggregateByWallet(walletId: string, currency: string): Promise<LedgerAggregate>;
}

export interface InboxRepository {
  /** Returns false when (consumerName, messageId) already exists. */
  tryInsert(message: InboxMessage): Promise<boolean>;
  markProcessed(consumerName: string, messageId: string, at: Date): Promise<void>;
}

export interface OutboxRepository {
  insert(messages: OutboxMessage[]): Promise<void>;
  /** Due unpublished rows, locked with FOR UPDATE SKIP LOCKED. */
  findDueForUpdate(now: Date, limit: number): Promise<OutboxMessage[]>;
  update(message: OutboxMessage): Promise<void>;
}

/** Repositories bound to one SQL transaction. */
export interface TransactionalRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/**
 * Unit of work: everything executed inside `run` commits or rolls back
 * atomically (wallet, transaction, ledger, inbox, outbox).
 */
export interface UnitOfWork {
  run<T>(fn: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
}

/** Publishes raw event envelopes to the events queue (used by the outbox worker). */
export interface EventPublisher {
  publish(envelope: Readonly<Record<string, unknown>>): Promise<void>;
}
