import type { Wallet } from "../../src/domain/entities/wallet";
import type {
  WagerTransaction,
  WagerTransactionKind,
} from "../../src/domain/entities/wager-transaction";
import { WagerTransactionStatus } from "../../src/domain/entities/wager-transaction";
import type { WalletLedgerEntry } from "../../src/domain/entities/wallet-ledger-entry";
import { LedgerDirection } from "../../src/domain/entities/wallet-ledger-entry";
import type { InboxMessage } from "../../src/domain/entities/inbox-message";
import type { OutboxMessage } from "../../src/domain/entities/outbox-message";
import { Money } from "../../src/domain/value-objects/money";
import {
  UniqueConstraintViolation,
  type InboxRepository,
  type LedgerRepository,
  type OutboxRepository,
  type TransactionalRepositories,
  type UnitOfWork,
  type WagerTransactionRepository,
  type WalletRepository,
} from "../../src/application/ports";

/**
 * In-memory fakes for unit-testing use cases. Integration and concurrency
 * tests use the real PostgreSQL/LocalStack stack — these fakes only serve
 * fast business-rule coverage.
 */

class InMemoryWallets implements WalletRepository {
  readonly byId = new Map<string, Wallet>();

  async insert(wallet: Wallet): Promise<void> {
    for (const existing of this.byId.values()) {
      if (existing.playerId === wallet.playerId && existing.currency === wallet.currency) {
        throw new UniqueConstraintViolation("wallets_player_currency_unique");
      }
    }
    this.byId.set(wallet.id, wallet);
  }

  async findById(id: string): Promise<Wallet | undefined> {
    return this.byId.get(id);
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    return this.byId.get(id);
  }

  async update(wallet: Wallet): Promise<void> {
    this.byId.set(wallet.id, wallet);
  }
}

class InMemoryTransactions implements WagerTransactionRepository {
  readonly items: WagerTransaction[] = [];

  async insert(transaction: WagerTransaction): Promise<void> {
    if (
      this.items.some(
        (t) =>
          t.providerId === transaction.providerId &&
          t.idempotencyKey === transaction.idempotencyKey,
      )
    ) {
      throw new UniqueConstraintViolation("wager_tx_provider_idempotency_unique");
    }
    if (
      this.items.some(
        (t) =>
          t.providerId === transaction.providerId &&
          t.externalTransactionId === transaction.externalTransactionId,
      )
    ) {
      throw new UniqueConstraintViolation("wager_tx_provider_external_unique");
    }
    this.items.push(transaction);
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const index = this.items.findIndex((t) => t.id === transaction.id);
    if (index >= 0) this.items[index] = transaction;
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.items.find((t) => t.id === id);
  }

  async findByProviderAndIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    return this.items.find(
      (t) => t.providerId === providerId && t.idempotencyKey === idempotencyKey,
    );
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.items.find(
      (t) => t.providerId === providerId && t.externalTransactionId === externalTransactionId,
    );
  }

  async existsProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    return this.items.some(
      (t) =>
        t.referenceTransactionId === referenceTransactionId &&
        (t.kind === "REFUND" || t.kind === "ROLLBACK") &&
        t.status === WagerTransactionStatus.Processed,
    );
  }

  async findDuePendingReferenceForUpdate(now: Date, limit: number): Promise<WagerTransaction[]> {
    return this.items
      .filter(
        (t) =>
          t.status === WagerTransactionStatus.PendingReference &&
          t.nextReferenceRetryAt !== undefined &&
          t.nextReferenceRetryAt <= now,
      )
      .slice(0, limit);
  }
}

class InMemoryLedger implements LedgerRepository {
  readonly items: WalletLedgerEntry[] = [];

  async insert(entry: WalletLedgerEntry): Promise<void> {
    if (this.items.some((e) => e.transactionId === entry.transactionId)) {
      throw new UniqueConstraintViolation("ledger_transaction_unique");
    }
    this.items.push(entry);
  }

  async findByWallet(walletId: string, cursor: string | undefined, limit: number) {
    const sorted = this.items
      .filter((e) => e.walletId === walletId)
      .sort((a, b) => a.id.localeCompare(b.id));
    const start = cursor ? sorted.findIndex((e) => e.id > cursor) : 0;
    const page = sorted.slice(start, start + limit);
    return {
      entries: page,
      nextCursor: sorted.length > start + limit ? page[page.length - 1]?.id : undefined,
    };
  }

  async aggregateByWallet(walletId: string, currency: string) {
    let credits = Money.zero(currency);
    let debits = Money.zero(currency);
    let count = 0;
    for (const entry of this.items.filter((e) => e.walletId === walletId)) {
      count += 1;
      if (entry.direction === LedgerDirection.Credit) credits = credits.add(entry.money);
      else debits = debits.add(entry.money);
    }
    return { credits, debits, count };
  }
}

class InMemoryInbox implements InboxRepository {
  readonly byKey = new Map<string, InboxMessage>();

  async tryInsert(message: InboxMessage): Promise<boolean> {
    const key = `${message.consumerName}:${message.messageId}`;
    if (this.byKey.has(key)) return false;
    this.byKey.set(key, message);
    return true;
  }

  async markProcessed(consumerName: string, messageId: string, at: Date): Promise<void> {
    this.byKey.get(`${consumerName}:${messageId}`)?.markProcessed(at);
  }
}

class InMemoryOutbox implements OutboxRepository {
  readonly items: OutboxMessage[] = [];

  async insert(messages: OutboxMessage[]): Promise<void> {
    this.items.push(...messages);
  }

  async findDueForUpdate(now: Date, limit: number): Promise<OutboxMessage[]> {
    return this.items.filter((m) => m.isDue(now)).slice(0, limit);
  }

  async update(_message: OutboxMessage): Promise<void> {
    // items are held by reference — nothing to do
  }
}

export class InMemoryRepos implements TransactionalRepositories {
  readonly wallets = new InMemoryWallets();
  readonly transactions = new InMemoryTransactions();
  readonly ledger = new InMemoryLedger();
  readonly inbox = new InMemoryInbox();
  readonly outbox = new InMemoryOutbox();
}

/** No real transactionality — unit tests assert behavior, not atomicity. */
export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(readonly repos = new InMemoryRepos()) {}

  async run<T>(fn: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    return fn(this.repos);
  }
}
