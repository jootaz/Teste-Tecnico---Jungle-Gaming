import { v7 as uuidv7 } from "uuid";
import { Money, type MoneyProps } from "../../domain/value-objects/money";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/entities/wager-transaction";
import { WalletLedgerEntry, LedgerDirection } from "../../domain/entities/wallet-ledger-entry";
import { InboxMessage } from "../../domain/entities/inbox-message";
import { OutboxMessage } from "../../domain/entities/outbox-message";
import type { Wallet } from "../../domain/entities/wallet";
import { BusinessRuleViolationError } from "../../domain/errors";
import { FailureCode } from "../../domain/failure-codes";
import { computePayloadHash } from "../../domain/services/payload-hash";
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  WalletBalanceChanged,
} from "../../domain/events/wagering-events";
import type { EventContext } from "../../domain/events/integration-event";
import {
  UniqueConstraintViolation,
  type TransactionalRepositories,
  type UnitOfWork,
} from "../ports";
import { IdempotencyConflictError, WalletNotFoundError } from "../errors";
import { withTransientRetry } from "../retry";
import { NoopMetrics, type MetricsPort } from "../metrics-port";

export interface SubmitWagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface ExecutionContext extends EventContext {
  /** Present when the command arrived through SQS — joins the inbox to the same SQL transaction. */
  inbox?: { consumerName: string; messageId: string };
}

export interface SubmitResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
  /** true when the SQS message was already fully processed (inbox hit). */
  duplicateMessage?: boolean;
}

const ROLLBACK_ALLOWED_REFERENCE_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
]);

export interface SubmitUseCaseOptions {
  pendingReferenceMaxAttempts: number;
  pendingReferenceBaseDelayMs: number;
  pendingReferenceMaxDelayMs: number;
}

const DEFAULT_OPTIONS: SubmitUseCaseOptions = {
  pendingReferenceMaxAttempts: 10,
  pendingReferenceBaseDelayMs: 1000,
  pendingReferenceMaxDelayMs: 60_000,
};

/**
 * Single entry point for applying a wager operation, shared by the HTTP
 * controller, the SQS consumer and the pending-reference worker.
 *
 * Everything inside one execution — inbox record, transaction row, wallet
 * balance, ledger entry and outbox events — commits atomically. Concurrency
 * is serialized per wallet with SELECT ... FOR UPDATE; database constraints
 * (unique keys, balance >= 0, ledger arithmetic) are the final backstop.
 */
export class SubmitWagerTransactionUseCase {
  private readonly options: SubmitUseCaseOptions;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: MetricsPort = new NoopMetrics(),
    options: Partial<SubmitUseCaseOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async execute(command: SubmitWagerTransactionCommand, ctx: ExecutionContext): Promise<SubmitResult> {
    // Throws InvalidMoneyError / DomainValidationError for contract violations —
    // mapped to 400 (HTTP) or permanent failure (SQS) by the caller.
    const money = Money.from(command.money);
    const payloadHash = computePayloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    try {
      return await withTransientRetry(() => this.runOnce(command, ctx, money, payloadHash));
    } catch (error) {
      if (error instanceof UniqueConstraintViolation) {
        // A concurrent request inserted the same transaction between our replay
        // check and our insert. Re-running resolves it through the replay path.
        this.metrics.lockConflict();
        return await withTransientRetry(() => this.runOnce(command, ctx, money, payloadHash));
      }
      throw error;
    }
  }

  private async runOnce(
    command: SubmitWagerTransactionCommand,
    ctx: ExecutionContext,
    money: Money,
    payloadHash: string,
  ): Promise<SubmitResult> {
    return this.uow.run(async (repos) => {
      if (ctx.inbox) {
        const fresh = await repos.inbox.tryInsert(
          InboxMessage.receive({
            messageId: ctx.inbox.messageId,
            consumerName: ctx.inbox.consumerName,
            payloadHash,
          }),
        );
        if (!fresh) {
          // The message was fully processed before (inbox row commits together
          // with its effects) — surface the original result when available.
          this.metrics.duplicateDetected("inbox");
          const existing = await repos.transactions.findByProviderAndIdempotencyKey(
            command.providerId,
            command.idempotencyKey,
          );
          return existing
            ? { ...this.replayResult(existing), duplicateMessage: true }
            : {
                transactionId: "",
                status: WagerTransactionStatus.Processed,
                idempotentReplay: true,
                duplicateMessage: true,
              };
        }
      }

      const existing = await repos.transactions.findByProviderAndIdempotencyKey(
        command.providerId,
        command.idempotencyKey,
      );
      if (existing) {
        if (!existing.matchesPayload(payloadHash)) {
          throw new IdempotencyConflictError(command.idempotencyKey);
        }
        this.metrics.duplicateDetected("idempotency");
        return this.replayResult(existing);
      }

      // Lock the wallet BEFORE inserting the transaction row. The insert takes
      // a FOR KEY SHARE on the wallet (FK validation); acquiring FOR UPDATE
      // only afterwards deadlocks two concurrent submissions on the same
      // wallet. Locking first gives every path a single acquisition order.
      const wallet = await repos.wallets.findByIdForUpdate(command.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(command.walletId);
      }

      const transaction = WagerTransaction.create({
        id: uuidv7(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
      });
      await repos.transactions.insert(transaction);

      if (ctx.inbox) {
        await repos.inbox.markProcessed(ctx.inbox.consumerName, ctx.inbox.messageId, new Date());
      }

      return this.applyWithLockedWallet(repos, transaction, wallet, ctx);
    });
  }

  /**
   * Worker entry point: locks the wallet, then applies the transaction.
   * Expects to run inside an open unit of work.
   */
  async applyToWallet(
    repos: TransactionalRepositories,
    transaction: WagerTransaction,
    ctx: EventContext,
  ): Promise<SubmitResult> {
    const wallet = await repos.wallets.findByIdForUpdate(transaction.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(transaction.walletId);
    }
    return this.applyWithLockedWallet(repos, transaction, wallet, ctx);
  }

  /** Applies (or rejects / parks) a transaction over an already-locked wallet. */
  private async applyWithLockedWallet(
    repos: TransactionalRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
  ): Promise<SubmitResult> {
    try {
      this.assertWalletMatches(transaction, wallet);

      let reference: WagerTransaction | undefined;
      if (transaction.requiresReference()) {
        reference = await repos.transactions.findByProviderAndExternalId(
          transaction.providerId,
          transaction.referenceExternalTransactionId!,
        );
        if (!reference || !reference.isTerminal()) {
          // Out-of-order delivery: park and let the scheduled worker retry.
          return this.parkOrExpire(repos, transaction, wallet, ctx);
        }
        this.validateReference(transaction, reference);
        // Stricter than "once per kind": any second reversal of the same
        // reference would duplicate the credit/debit (see ARCHITECTURE.md).
        if (await repos.transactions.existsProcessedReversal(reference.id)) {
          throw new BusinessRuleViolationError(
            FailureCode.ReferenceAlreadyReversed,
            `reference ${reference.id} was already reversed`,
          );
        }
      } else if (
        transaction.kind === WagerTransactionKind.Win &&
        transaction.referenceExternalTransactionId
      ) {
        // WIN may reference the BET of the same round — informational link only.
        reference = await repos.transactions.findByProviderAndExternalId(
          transaction.providerId,
          transaction.referenceExternalTransactionId,
        );
      }

      return await this.applyEffect(repos, transaction, wallet, reference, ctx);
    } catch (error) {
      if (error instanceof BusinessRuleViolationError) {
        return this.rejectTransaction(repos, transaction, wallet, error.failureCode, ctx);
      }
      throw error;
    }
  }

  // ---- helpers -------------------------------------------------------------

  private assertWalletMatches(transaction: WagerTransaction, wallet: Wallet): void {
    if (wallet.playerId !== transaction.playerId) {
      throw new BusinessRuleViolationError(
        FailureCode.PlayerWalletMismatch,
        `wallet ${wallet.id} does not belong to player ${transaction.playerId}`,
      );
    }
    if (wallet.currency !== transaction.money.currency) {
      throw new BusinessRuleViolationError(
        FailureCode.CurrencyMismatch,
        `operation currency ${transaction.money.currency} does not match wallet currency ${wallet.currency}`,
      );
    }
  }

  private validateReference(transaction: WagerTransaction, reference: WagerTransaction): void {
    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new BusinessRuleViolationError(
        FailureCode.ReferenceNotProcessed,
        `reference ${reference.id} is ${reference.status}, only PROCESSED references can be reversed`,
      );
    }
    const sameContext =
      reference.playerId === transaction.playerId &&
      reference.walletId === transaction.walletId &&
      reference.roundId === transaction.roundId &&
      reference.money.currency === transaction.money.currency;
    if (!sameContext) {
      throw new BusinessRuleViolationError(
        FailureCode.ReferenceContextMismatch,
        `reference ${reference.id} belongs to a different player, wallet, round or currency`,
      );
    }
    const kindAllowed =
      transaction.kind === WagerTransactionKind.Refund
        ? reference.kind === WagerTransactionKind.Bet
        : ROLLBACK_ALLOWED_REFERENCE_KINDS.has(reference.kind);
    if (!kindAllowed) {
      throw new BusinessRuleViolationError(
        FailureCode.ReferenceKindMismatch,
        `${transaction.kind} cannot reference a ${reference.kind}`,
      );
    }
    if (!transaction.money.equals(reference.money)) {
      throw new BusinessRuleViolationError(
        FailureCode.ReferenceAmountMismatch,
        `amount ${transaction.money.toString()} differs from referenced amount ${reference.money.toString()} (partial reversal is out of scope)`,
      );
    }
  }

  private async parkOrExpire(
    repos: TransactionalRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
  ): Promise<SubmitResult> {
    if (transaction.referenceRetryAttempts >= this.options.pendingReferenceMaxAttempts) {
      return this.rejectTransaction(repos, transaction, wallet, FailureCode.ReferenceNotFound, ctx);
    }
    transaction.markPendingReference();
    transaction.scheduleReferenceRetry(
      new Date(),
      this.options.pendingReferenceBaseDelayMs,
      this.options.pendingReferenceMaxDelayMs,
    );
    await repos.transactions.update(transaction);
    await repos.outbox.insert([
      OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, ctx)),
    ]);
    this.metrics.pendingReferenceScheduled();
    return {
      transactionId: transaction.id,
      status: transaction.status,
      idempotentReplay: false,
    };
  }

  private async applyEffect(
    repos: TransactionalRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    reference: WagerTransaction | undefined,
    ctx: EventContext,
  ): Promise<SubmitResult> {
    const now = new Date();
    let entry: WalletLedgerEntry | undefined;

    if (transaction.affectsBalance()) {
      const direction = transaction.ledgerDirectionFor(reference);
      let movement;
      if (direction === LedgerDirection.Debit) {
        try {
          movement = wallet.debit(transaction.money, now);
        } catch (error) {
          // A reversal that would overdraw is operationally different from a
          // bet without funds — distinct failure code (business rule 9).
          if (
            error instanceof BusinessRuleViolationError &&
            error.failureCode === FailureCode.InsufficientFunds &&
            transaction.kind === WagerTransactionKind.Rollback
          ) {
            throw new BusinessRuleViolationError(
              FailureCode.ReversalWouldOverdraw,
              `rollback of ${reference?.id} would overdraw wallet ${wallet.id}`,
            );
          }
          throw error;
        }
      } else {
        movement = wallet.credit(transaction.money, now);
      }

      entry = WalletLedgerEntry.create({
        id: uuidv7(),
        walletId: wallet.id,
        transactionId: transaction.id,
        direction,
        money: transaction.money,
        balanceBefore: movement.balanceBefore,
        balanceAfter: movement.balanceAfter,
        createdAt: now,
      });
      await repos.wallets.update(wallet);
      await repos.ledger.insert(entry);
    }

    transaction.markProcessed(reference?.id, now, wallet.balance);
    await repos.transactions.update(transaction);

    const events = [OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, ctx))];
    if (entry) {
      events.push(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx)));
    }
    await repos.outbox.insert(events);

    this.metrics.transactionFinalized(transaction.kind, transaction.status);
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private async rejectTransaction(
    repos: TransactionalRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    code: FailureCode,
    ctx: EventContext,
  ): Promise<SubmitResult> {
    transaction.reject(code, wallet.balance);
    await repos.transactions.update(transaction);
    await repos.outbox.insert([OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, ctx))]);
    this.metrics.transactionFinalized(transaction.kind, transaction.status);
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: wallet.balance.toJSON(),
      failureCode: code,
      idempotentReplay: false,
    };
  }

  private replayResult(existing: WagerTransaction): SubmitResult {
    return {
      transactionId: existing.id,
      status: existing.status,
      balance: existing.observedBalance?.toJSON(),
      failureCode: existing.failureCode,
      idempotentReplay: true,
    };
  }
}
