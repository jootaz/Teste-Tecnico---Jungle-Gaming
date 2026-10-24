import { LockMode, UniqueConstraintViolationException } from "@mikro-orm/core";
import type { SqlEntityManager } from "@mikro-orm/postgresql";
import type { Wallet } from "../../domain/entities/wallet";
import type { WagerTransaction } from "../../domain/entities/wager-transaction";
import { WagerTransactionStatus } from "../../domain/entities/wager-transaction";
import type { WalletLedgerEntry } from "../../domain/entities/wallet-ledger-entry";
import type { InboxMessage } from "../../domain/entities/inbox-message";
import type { OutboxMessage } from "../../domain/entities/outbox-message";
import { Money } from "../../domain/value-objects/money";
import {
  UniqueConstraintViolation,
  type InboxRepository,
  type LedgerAggregate,
  type LedgerPage,
  type LedgerRepository,
  type OutboxRepository,
  type WagerTransactionRepository,
  type WalletRepository,
} from "../../application/ports";
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "./records";
import {
  ledgerToDomain,
  outboxToDomain,
  transactionToDomain,
  transactionToRecordData,
  walletToDomain,
} from "./mappers";

function mapUniqueViolation(error: unknown): never {
  if (error instanceof UniqueConstraintViolationException) {
    const constraint =
      (error as unknown as { constraint?: string }).constraint ??
      ((error as { cause?: { constraint?: string } }).cause?.constraint ?? "unknown");
    throw new UniqueConstraintViolation(constraint);
  }
  throw error;
}

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletRecord, {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balanceAmount: wallet.balance.toJSON().amount,
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      });
    } catch (error) {
      mapUniqueViolation(error);
    }
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id });
    return record ? walletToDomain(record) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? walletToDomain(record) : undefined;
  }

  async update(wallet: Wallet): Promise<void> {
    await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id },
      {
        balanceAmount: wallet.balance.toJSON().amount,
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    try {
      await this.em.insert(WagerTransactionRecord, transactionToRecordData(transaction) as never);
    } catch (error) {
      mapUniqueViolation(error);
    }
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const { id, ...data } = transactionToRecordData(transaction);
    try {
      await this.em.nativeUpdate(WagerTransactionRecord, { id: transaction.id }, data);
    } catch (error) {
      mapUniqueViolation(error);
    }
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { id });
    return record ? transactionToDomain(record) : undefined;
  }

  async findByProviderAndIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { providerId, idempotencyKey });
    return record ? transactionToDomain(record) : undefined;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, {
      providerId,
      externalTransactionId,
    });
    return record ? transactionToDomain(record) : undefined;
  }

  async existsProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: ["REFUND", "ROLLBACK"] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async findDuePendingReferenceForUpdate(now: Date, limit: number): Promise<WagerTransaction[]> {
    const records = await this.em
      .createQueryBuilder(WagerTransactionRecord, "t")
      .select("*")
      .where({
        status: WagerTransactionStatus.PendingReference,
        nextReferenceRetryAt: { $lte: now },
      })
      .orderBy({ nextReferenceRetryAt: "asc" })
      .limit(limit)
      // FOR UPDATE SKIP LOCKED: concurrent workers never claim the same row.
      .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE)
      .getResultList();
    return records.map(transactionToDomain);
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    try {
      await this.em.insert(LedgerEntryRecord, {
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: entry.money.toJSON().amount,
        currency: entry.money.currency,
        balanceBefore: entry.balanceBefore.toJSON().amount,
        balanceAfter: entry.balanceAfter.toJSON().amount,
        createdAt: entry.createdAt,
      });
    } catch (error) {
      mapUniqueViolation(error);
    }
  }

  async findByWallet(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const afterId = cursor ? decodeCursor(cursor) : undefined;
    const records = await this.em.find(
      LedgerEntryRecord,
      { walletId, ...(afterId ? { id: { $gt: afterId } } : {}) },
      { orderBy: { id: "asc" }, limit: limit + 1 },
    );
    const hasMore = records.length > limit;
    const page = hasMore ? records.slice(0, limit) : records;
    const last = page[page.length - 1];
    return {
      entries: page.map(ledgerToDomain),
      nextCursor: hasMore && last ? encodeCursor(last.id) : undefined,
    };
  }

  async aggregateByWallet(walletId: string, currency: string): Promise<LedgerAggregate> {
    const rows = (await this.em.getConnection().execute(
      `select
         coalesce(sum(amount) filter (where direction = 'CREDIT'), 0)::numeric(18,2)::text as credits,
         coalesce(sum(amount) filter (where direction = 'DEBIT'), 0)::numeric(18,2)::text as debits,
         count(*)::int as count
       from wallet_ledger_entries
       where wallet_id = ?`,
      [walletId],
      "all",
      this.em.getTransactionContext(),
    )) as Array<{ credits: string; debits: string; count: number }>;
    const row = rows[0] ?? { credits: "0.00", debits: "0.00", count: 0 };
    return {
      credits: Money.from({ amount: row.credits, currency }),
      debits: Money.from({ amount: row.debits, currency }),
      count: Number(row.count),
    };
  }
}

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async tryInsert(message: InboxMessage): Promise<boolean> {
    // ON CONFLICT DO NOTHING instead of catching the violation: a failed
    // INSERT would abort the surrounding PostgreSQL transaction. The raw
    // execute must join the ongoing transaction explicitly (4th argument),
    // otherwise it runs on a separate pooled connection.
    const result = (await this.em.getConnection().execute(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
      "run",
      this.em.getTransactionContext(),
    )) as { affectedRows?: number; rowCount?: number };
    const affected = result.affectedRows ?? result.rowCount ?? 0;
    return affected > 0;
  }

  async markProcessed(consumerName: string, messageId: string, at: Date): Promise<void> {
    await this.em.nativeUpdate(InboxMessageRecord, { consumerName, messageId }, { processedAt: at });
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async insert(messages: OutboxMessage[]): Promise<void> {
    for (const message of messages) {
      await this.em.insert(OutboxMessageRecord, {
        id: message.id,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        payload: message.payload as Record<string, unknown>,
        occurredAt: message.occurredAt,
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
      } as never);
    }
  }

  async findDueForUpdate(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await this.em
      .createQueryBuilder(OutboxMessageRecord, "o")
      .select("*")
      .where({ publishedAt: null, nextAttemptAt: { $lte: now } })
      .orderBy({ occurredAt: "asc" })
      .limit(limit)
      .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE)
      .getResultList();
    return records.map(outboxToDomain);
  }

  async update(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
      } as never,
    );
  }
}

function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}
