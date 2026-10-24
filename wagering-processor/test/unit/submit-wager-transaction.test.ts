import { beforeEach, describe, expect, test } from "bun:test";
import { v7 as uuidv7 } from "uuid";
import {
  SubmitWagerTransactionUseCase,
  type SubmitWagerTransactionCommand,
} from "../../src/application/use-cases/submit-wager-transaction";
import { CreateWalletUseCase } from "../../src/application/use-cases/create-wallet";
import { ProcessPendingReferencesUseCase } from "../../src/application/use-cases/process-pending-references";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet";
import { InMemoryUnitOfWork } from "../helpers/in-memory";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/entities/wager-transaction";
import { FailureCode } from "../../src/domain/failure-codes";
import { IdempotencyConflictError, WalletNotFoundError } from "../../src/application/errors";

const ctx = { correlationId: "test" };

describe("SubmitWagerTransactionUseCase", () => {
  let uow: InMemoryUnitOfWork;
  let useCase: SubmitWagerTransactionUseCase;
  let walletId: string;
  const playerId = uuidv7();

  function command(overrides: Partial<SubmitWagerTransactionCommand> = {}): SubmitWagerTransactionCommand {
    const externalId = overrides.externalTransactionId ?? uuidv7();
    return {
      providerId: "provider-a",
      externalTransactionId: externalId,
      idempotencyKey: `provider-a:${externalId}`,
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "25.00", currency: "BRL" },
      ...overrides,
    };
  }

  beforeEach(async () => {
    uow = new InMemoryUnitOfWork();
    useCase = new SubmitWagerTransactionUseCase(uow, undefined, {
      pendingReferenceMaxAttempts: 3,
      pendingReferenceBaseDelayMs: 0,
      pendingReferenceMaxDelayMs: 0,
    });
    const created = await new CreateWalletUseCase(uow).execute(
      { playerId, initialBalance: { amount: "100.00", currency: "BRL" } },
      ctx,
    );
    walletId = created.id;
  });

  // ---- BET -----------------------------------------------------------------

  test("BET debits the balance and writes one DEBIT ledger entry", async () => {
    const result = await useCase.execute(command(), ctx);
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: "75.00", currency: "BRL" });
    expect(result.idempotentReplay).toBe(false);

    const entries = uow.repos.ledger.items.filter((e) => e.direction === "DEBIT");
    expect(entries.length).toBe(1);
    expect(entries[0]!.money.toJSON().amount).toBe("25.00");
  });

  test("BET without funds is REJECTED with INSUFFICIENT_FUNDS and no ledger entry", async () => {
    const result = await useCase.execute(command({ money: { amount: "100.01", currency: "BRL" } }), ctx);
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.balance).toEqual({ amount: "100.00", currency: "BRL" });
    expect(uow.repos.ledger.items.filter((e) => e.direction === "DEBIT").length).toBe(0);
  });

  test("currency conflict is REJECTED with CURRENCY_MISMATCH", async () => {
    const result = await useCase.execute(command({ money: { amount: "10.00", currency: "USD" } }), ctx);
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
  });

  test("wallet owned by another player is REJECTED with PLAYER_WALLET_MISMATCH", async () => {
    const result = await useCase.execute(command({ playerId: uuidv7() }), ctx);
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.PlayerWalletMismatch);
  });

  test("unknown wallet throws WalletNotFoundError without persisting anything", async () => {
    await expect(useCase.execute(command({ walletId: uuidv7() }), ctx)).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
    expect(uow.repos.transactions.items.filter((t) => t.kind !== "OPENING").length).toBe(0);
  });

  // ---- idempotency ----------------------------------------------------------

  test("identical repeat returns the original result with idempotentReplay=true", async () => {
    const cmd = command();
    const first = await useCase.execute(cmd, ctx);
    const second = await useCase.execute(cmd, ctx);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.status).toBe(first.status);
    expect(second.balance).toEqual(first.balance);
    // Only one debit was applied.
    const wallet = await uow.repos.wallets.findById(walletId);
    expect(wallet!.balance.toJSON().amount).toBe("75.00");
  });

  test("replay returns the balance observed at processing time, not the current one", async () => {
    const cmd = command();
    const first = await useCase.execute(cmd, ctx);
    // Another bet moves the balance afterwards.
    await useCase.execute(command(), ctx);
    const replay = await useCase.execute(cmd, ctx);
    expect(replay.balance).toEqual(first.balance);
  });

  test("same idempotency key with different payload is a conflict, not a replay", async () => {
    const cmd = command();
    await useCase.execute(cmd, ctx);
    const conflicting = { ...cmd, money: { amount: "30.00", currency: "BRL" } };
    await expect(useCase.execute(conflicting, ctx)).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  test("replay of a REJECTED transaction returns the original rejection", async () => {
    const cmd = command({ money: { amount: "500.00", currency: "BRL" } });
    const first = await useCase.execute(cmd, ctx);
    const replay = await useCase.execute(cmd, ctx);
    expect(first.status).toBe(WagerTransactionStatus.Rejected);
    expect(replay.status).toBe(WagerTransactionStatus.Rejected);
    expect(replay.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(replay.idempotentReplay).toBe(true);
  });

  // ---- WIN / LOSS -----------------------------------------------------------

  test("WIN credits the balance", async () => {
    const result = await useCase.execute(
      command({ kind: WagerTransactionKind.Win, money: { amount: "50.00", currency: "BRL" } }),
      ctx,
    );
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: "150.00", currency: "BRL" });
  });

  test("LOSS is processed without balance change or ledger entry", async () => {
    const before = uow.repos.ledger.items.length;
    const result = await useCase.execute(command({ kind: WagerTransactionKind.Loss }), ctx);
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: "100.00", currency: "BRL" });
    expect(uow.repos.ledger.items.length).toBe(before);
    // LOSS still publishes WagerTransactionProcessed
    expect(uow.repos.outbox.items.some((m) => m.eventType === "WagerTransactionProcessed")).toBe(true);
  });

  // ---- REFUND ---------------------------------------------------------------

  test("REFUND reverses a processed BET exactly once", async () => {
    const bet = command();
    await useCase.execute(bet, ctx);

    const refund = command({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const result = await useCase.execute(refund, ctx);
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: "100.00", currency: "BRL" });

    // A second refund of the same bet is rejected.
    const second = await useCase.execute(
      command({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      ctx,
    );
    expect(second.status).toBe(WagerTransactionStatus.Rejected);
    expect(second.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
  });

  test("ROLLBACK after a REFUND of the same BET is rejected (single reversal per reference)", async () => {
    const bet = command();
    await useCase.execute(bet, ctx);
    await useCase.execute(
      command({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      ctx,
    );
    const rollback = await useCase.execute(
      command({
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      ctx,
    );
    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
  });

  test("REFUND of a WIN is rejected with REFERENCE_KIND_MISMATCH", async () => {
    const win = command({ kind: WagerTransactionKind.Win });
    await useCase.execute(win, ctx);
    const result = await useCase.execute(
      command({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: win.externalTransactionId,
      }),
      ctx,
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.ReferenceKindMismatch);
  });

  test("REFUND with a different amount is rejected with REFERENCE_AMOUNT_MISMATCH", async () => {
    const bet = command();
    await useCase.execute(bet, ctx);
    const result = await useCase.execute(
      command({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: bet.externalTransactionId,
        money: { amount: "10.00", currency: "BRL" },
      }),
      ctx,
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
  });

  test("REFUND referencing another round is rejected with REFERENCE_CONTEXT_MISMATCH", async () => {
    const bet = command({ roundId: "round-1" });
    await useCase.execute(bet, ctx);
    const result = await useCase.execute(
      command({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: bet.externalTransactionId,
        roundId: "round-2",
      }),
      ctx,
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.ReferenceContextMismatch);
  });

  test("REFUND of a REJECTED reference is rejected with REFERENCE_NOT_PROCESSED", async () => {
    const bigBet = command({ money: { amount: "999.00", currency: "BRL" } });
    await useCase.execute(bigBet, ctx); // rejected (insufficient funds)
    const result = await useCase.execute(
      command({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: bigBet.externalTransactionId,
        money: { amount: "999.00", currency: "BRL" },
      }),
      ctx,
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });

  // ---- ROLLBACK -------------------------------------------------------------

  test("ROLLBACK of a BET credits the amount back", async () => {
    const bet = command();
    await useCase.execute(bet, ctx);
    const result = await useCase.execute(
      command({
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      ctx,
    );
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: "100.00", currency: "BRL" });
  });

  test("ROLLBACK of a WIN debits, and overdraw gets a distinct failure code", async () => {
    const win = command({ kind: WagerTransactionKind.Win, money: { amount: "50.00", currency: "BRL" } });
    await useCase.execute(win, ctx); // balance 150
    // Spend almost everything so the rollback debit cannot be covered.
    await useCase.execute(command({ money: { amount: "140.00", currency: "BRL" } }), ctx); // balance 10

    const result = await useCase.execute(
      command({
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: win.externalTransactionId,
        money: { amount: "50.00", currency: "BRL" },
      }),
      ctx,
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    // Distinct from a bet without funds, and still auditable.
    expect(result.failureCode).not.toBe(FailureCode.InsufficientFunds);
  });

  test("ROLLBACK of a REFUND debits the refunded amount", async () => {
    const bet = command();
    await useCase.execute(bet, ctx); // 75
    const refund = command({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await useCase.execute(refund, ctx); // 100
    const result = await useCase.execute(
      command({
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: refund.externalTransactionId,
      }),
      ctx,
    );
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: "75.00", currency: "BRL" });
  });

  // ---- out-of-order references ----------------------------------------------

  test("REFUND arriving before its BET is parked as PENDING_REFERENCE and recovers", async () => {
    const betExternalId = uuidv7();
    const refund = command({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: betExternalId,
    });
    const parked = await useCase.execute(refund, ctx);
    expect(parked.status).toBe(WagerTransactionStatus.PendingReference);
    expect(
      uow.repos.outbox.items.some((m) => m.eventType === "WagerTransactionPendingReference"),
    ).toBe(true);

    // The referenced BET arrives late.
    await useCase.execute(command({ externalTransactionId: betExternalId }), ctx); // balance 75

    // The scheduled worker picks the parked transaction up.
    const worker = new ProcessPendingReferencesUseCase(uow, useCase);
    const touched = await worker.executeBatch(10);
    expect(touched).toBe(1);

    const stored = await uow.repos.transactions.findById(parked.transactionId);
    expect(stored!.status).toBe(WagerTransactionStatus.Processed);
    const wallet = await uow.repos.wallets.findById(walletId);
    expect(wallet!.balance.toJSON().amount).toBe("100.00");
  });

  test("PENDING_REFERENCE is rejected with REFERENCE_NOT_FOUND after the retry budget", async () => {
    const refund = command({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: uuidv7(),
    });
    const parked = await useCase.execute(refund, ctx);

    const worker = new ProcessPendingReferencesUseCase(uow, useCase);
    // Max attempts is 3 in this test setup; force due times in the past.
    for (let i = 0; i < 5; i++) {
      const stored = await uow.repos.transactions.findById(parked.transactionId);
      if (stored?.status !== WagerTransactionStatus.PendingReference) break;
      // Make it due immediately.
      stored.scheduleReferenceRetry(new Date(Date.now() - 600_000), 1, 1);
      await uow.repos.transactions.update(stored);
      await worker.executeBatch(10);
    }

    const final = await uow.repos.transactions.findById(parked.transactionId);
    expect(final!.status).toBe(WagerTransactionStatus.Rejected);
    expect(final!.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(uow.repos.outbox.items.some((m) => m.eventType === "WagerTransactionRejected")).toBe(true);
  });

  // ---- inbox (SQS path) -------------------------------------------------------

  test("duplicate SQS message is detected by the persistent inbox", async () => {
    const cmd = command();
    const sqsCtx = {
      correlationId: "msg-1",
      inbox: { consumerName: "wager-transactions-consumer", messageId: "msg-1" },
    };
    const first = await useCase.execute(cmd, sqsCtx);
    expect(first.duplicateMessage).toBeUndefined();

    const duplicate = await useCase.execute(cmd, sqsCtx);
    expect(duplicate.duplicateMessage).toBe(true);
    const wallet = await uow.repos.wallets.findById(walletId);
    expect(wallet!.balance.toJSON().amount).toBe("75.00");
  });

  // ---- events ---------------------------------------------------------------

  test("events are enqueued in the outbox, never published directly", async () => {
    await useCase.execute(command(), ctx);
    const types = uow.repos.outbox.items.map((m) => m.eventType);
    expect(types).toContain("WagerTransactionProcessed");
    expect(types).toContain("WalletBalanceChanged");
    for (const message of uow.repos.outbox.items) {
      expect(message.isPending()).toBe(true);
    }
  });

  // ---- reconciliation ---------------------------------------------------------

  test("reconciliation matches stored balance against the ledger", async () => {
    await useCase.execute(command(), ctx);
    await useCase.execute(command({ kind: WagerTransactionKind.Win }), ctx);
    const result = await new ReconcileWalletUseCase(uow).execute(walletId);
    expect(result.consistent).toBe(true);
    expect(result.difference.amount).toBe("0.00");
    expect(result.checkedEntries).toBe(3); // opening + bet + win
    expect(result.storedBalance).toEqual(result.calculatedBalance);
  });
});
