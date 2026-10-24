import { describe, expect, test } from "bun:test";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/entities/wager-transaction";
import { LedgerDirection, WalletLedgerEntry } from "../../src/domain/entities/wallet-ledger-entry";
import { Money } from "../../src/domain/value-objects/money";
import { DomainValidationError, InvalidTransactionStateError } from "../../src/domain/errors";
import { FailureCode } from "../../src/domain/failure-codes";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

function makeTransaction(
  kind: WagerTransactionKind,
  referenceExternalTransactionId?: string,
): WagerTransaction {
  return WagerTransaction.create({
    id: crypto.randomUUID(),
    providerId: "provider-a",
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    payloadHash: "hash",
    walletId: "w-1",
    playerId: "p-1",
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: brl("25.00"),
    referenceExternalTransactionId,
  });
}

describe("WagerTransaction", () => {
  test("is born PENDING", () => {
    expect(makeTransaction(WagerTransactionKind.Bet).status).toBe(WagerTransactionStatus.Pending);
  });

  test("OPENING cannot be created through the external factory", () => {
    expect(() => makeTransaction(WagerTransactionKind.Opening)).toThrow(DomainValidationError);
  });

  test("REFUND and ROLLBACK require a reference; BET and LOSS must not carry one", () => {
    expect(() => makeTransaction(WagerTransactionKind.Refund)).toThrow(DomainValidationError);
    expect(() => makeTransaction(WagerTransactionKind.Rollback)).toThrow(DomainValidationError);
    expect(makeTransaction(WagerTransactionKind.Refund, "ext-1").requiresReference()).toBe(true);
    expect(() => makeTransaction(WagerTransactionKind.Bet, "ext-1")).toThrow(DomainValidationError);
    expect(() => makeTransaction(WagerTransactionKind.Loss, "ext-1")).toThrow(DomainValidationError);
    // WIN may optionally reference the BET of the round
    expect(makeTransaction(WagerTransactionKind.Win, "ext-1").requiresReference()).toBe(false);
  });

  test("LOSS does not affect the balance", () => {
    expect(makeTransaction(WagerTransactionKind.Loss).affectsBalance()).toBe(false);
    expect(makeTransaction(WagerTransactionKind.Bet).affectsBalance()).toBe(true);
  });

  test("terminal states cannot transition again", () => {
    const processed = makeTransaction(WagerTransactionKind.Bet);
    processed.markProcessed(undefined, new Date(), brl("75.00"));
    expect(processed.isTerminal()).toBe(true);
    expect(() => processed.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    expect(() => processed.markProcessed(undefined, new Date(), brl("75.00"))).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => processed.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(() => processed.fail(FailureCode.PermanentInfrastructureError)).toThrow(
      InvalidTransactionStateError,
    );

    const rejected = makeTransaction(WagerTransactionKind.Bet);
    rejected.reject(FailureCode.InsufficientFunds);
    expect(rejected.isTerminal()).toBe(true);
    expect(() => rejected.markProcessed(undefined, new Date(), brl("0.00"))).toThrow(
      InvalidTransactionStateError,
    );
  });

  test("PENDING_REFERENCE can still be processed or rejected", () => {
    const transaction = makeTransaction(WagerTransactionKind.Refund, "ext-1");
    transaction.markPendingReference();
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    transaction.markProcessed("ref-id", new Date(), brl("50.00"));
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBe("ref-id");
  });

  test("reference retry backoff grows exponentially and is capped", () => {
    const transaction = makeTransaction(WagerTransactionKind.Rollback, "ext-1");
    const now = new Date("2026-01-01T00:00:00Z");
    transaction.scheduleReferenceRetry(now, 1000, 8000);
    expect(transaction.nextReferenceRetryAt!.getTime() - now.getTime()).toBe(1000);
    transaction.scheduleReferenceRetry(now, 1000, 8000);
    expect(transaction.nextReferenceRetryAt!.getTime() - now.getTime()).toBe(2000);
    for (let i = 0; i < 10; i++) transaction.scheduleReferenceRetry(now, 1000, 8000);
    expect(transaction.nextReferenceRetryAt!.getTime() - now.getTime()).toBe(8000);
    expect(transaction.referenceRetryAttempts).toBe(12);
  });

  test("payload matching", () => {
    const transaction = makeTransaction(WagerTransactionKind.Bet);
    expect(transaction.matchesPayload("hash")).toBe(true);
    expect(transaction.matchesPayload("other")).toBe(false);
  });

  test("ledger directions, including ROLLBACK inversion", () => {
    const bet = makeTransaction(WagerTransactionKind.Bet);
    bet.markProcessed(undefined, new Date(), brl("0.00"));
    const win = makeTransaction(WagerTransactionKind.Win);
    win.markProcessed(undefined, new Date(), brl("0.00"));

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(makeTransaction(WagerTransactionKind.Refund, "e").ledgerDirectionFor(bet)).toBe(
      LedgerDirection.Credit,
    );
    const rollbackOfBet = makeTransaction(WagerTransactionKind.Rollback, "e");
    expect(rollbackOfBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollbackOfBet.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(() => makeTransaction(WagerTransactionKind.Loss).ledgerDirectionFor()).toThrow(
      DomainValidationError,
    );
  });
});

describe("WalletLedgerEntry", () => {
  const base = {
    id: "e-1",
    walletId: "w-1",
    transactionId: "t-1",
    money: brl("25.00"),
  };

  test("create validates the arithmetic", () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      balanceBefore: brl("100.00"),
      balanceAfter: brl("75.00"),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  test("unbalanced entries are rejected at the factory", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        balanceBefore: brl("100.00"),
        balanceAfter: brl("80.00"),
      }),
    ).toThrow(DomainValidationError);
  });

  test("negative balances and non-positive amounts are rejected", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        money: brl("0.00"),
        direction: LedgerDirection.Credit,
        balanceBefore: brl("1.00"),
        balanceAfter: brl("1.00"),
      }),
    ).toThrow(DomainValidationError);
  });
});
