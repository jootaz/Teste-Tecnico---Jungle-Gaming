import { describe, expect, test } from "bun:test";
import { OutboxMessage } from "../../src/domain/entities/outbox-message";
import { WagerTransactionProcessed } from "../../src/domain/events/wagering-events";
import { WagerTransaction, WagerTransactionKind } from "../../src/domain/entities/wager-transaction";
import { Money } from "../../src/domain/value-objects/money";

function makeMessage(): OutboxMessage {
  const transaction = WagerTransaction.create({
    id: crypto.randomUUID(),
    providerId: "provider-a",
    externalTransactionId: "tx-1",
    idempotencyKey: "provider-a:tx-1",
    payloadHash: "hash",
    walletId: "w-1",
    playerId: "p-1",
    roundId: "r-1",
    gameId: "g-1",
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: "25.00", currency: "BRL" }),
  });
  transaction.markProcessed(undefined, new Date(), Money.from({ amount: "75.00", currency: "BRL" }));
  return OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, { correlationId: "c-1" }));
}

describe("OutboxMessage", () => {
  test("enqueue produces a pending, immediately due message with the serialized envelope", () => {
    const message = makeMessage();
    expect(message.isPending()).toBe(true);
    expect(message.isDue(new Date())).toBe(true);
    expect(message.attempts).toBe(0);
    expect(message.payload.eventType).toBe("WagerTransactionProcessed");
    expect(message.payload.version).toBe(1);
    const data = message.payload.data as { money: { amount: string } };
    expect(data.money.amount).toBe("25.00"); // MoneyProps, never a Money instance
  });

  test("markPublished makes it non-pending", () => {
    const message = makeMessage();
    message.markPublished(new Date());
    expect(message.isPending()).toBe(false);
    expect(message.isDue(new Date())).toBe(false);
  });

  test("scheduleRetry applies capped exponential backoff", () => {
    const message = makeMessage();
    const now = new Date("2026-01-01T00:00:00Z");
    message.scheduleRetry(now);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt!.getTime() - now.getTime()).toBe(1000);
    message.scheduleRetry(now);
    expect(message.nextAttemptAt!.getTime() - now.getTime()).toBe(2000);
    for (let i = 0; i < 10; i++) message.scheduleRetry(now);
    expect(message.nextAttemptAt!.getTime() - now.getTime()).toBe(60_000);
    expect(message.isDue(now)).toBe(false);
    expect(message.isDue(new Date(now.getTime() + 61_000))).toBe(true);
  });
});
