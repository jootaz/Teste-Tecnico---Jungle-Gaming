import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { v7 as uuidv7 } from "uuid";
import {
  brl,
  createTestContext,
  createTestQueues,
  drainQueue,
  expectWalletConsistent,
  sendWagerMessage,
  waitFor,
  type TestContext,
  type TestQueues,
} from "../helpers/integration";
import { WagerTransactionsConsumer, CONSUMER_NAME } from "../../src/infrastructure/messaging/consumer";
import { createLogger } from "../../src/infrastructure/observability/logger";
import { Metrics } from "../../src/infrastructure/observability/metrics";
import { WagerTransactionKind } from "../../src/domain/entities/wager-transaction";

describe("SQS consumer (real LocalStack + PostgreSQL)", () => {
  let ctx: TestContext;
  let queues: TestQueues;
  let consumer: WagerTransactionsConsumer;
  let walletId: string;
  const playerId = uuidv7();

  const walletBalance = async (): Promise<string> => {
    const rows = (await ctx.orm.em
      .fork()
      .getConnection()
      .execute(`select balance_amount from wallets where id = ?`, [walletId])) as Array<{
      balance_amount: string;
    }>;
    return rows[0]!.balance_amount;
  };

  const debitCount = async (): Promise<number> => {
    const rows = (await ctx.orm.em
      .fork()
      .getConnection()
      .execute(
        `select count(*)::int as c from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
        [walletId],
      )) as Array<{ c: number }>;
    return rows[0]!.c;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    queues = await createTestQueues(3);
    const wallet = await ctx.createWallet.execute(
      { playerId, initialBalance: brl("1000.00") },
      { correlationId: "t" },
    );
    walletId = wallet.id;
    consumer = new WagerTransactionsConsumer(
      queues.client,
      queues.transactions,
      queues.dlq,
      ctx.submit,
      createLogger(),
      new Metrics(),
      1,
    );
    consumer.start();
  });

  afterAll(async () => {
    await consumer.stop();
    await ctx.destroy();
  });

  function wagerData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const externalId = (overrides.externalTransactionId as string) ?? uuidv7();
    return {
      providerId: "provider-a",
      externalTransactionId: externalId,
      idempotencyKey: `provider-a:${externalId}`,
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "game-1",
      kind: "BET",
      money: brl("25.00"),
      ...overrides,
    };
  }

  test("consumes a message, applies the bet and acks after commit", async () => {
    const data = wagerData();
    await sendWagerMessage(queues, data);
    await waitFor(async () => (await debitCount()) === 1);
    expect(await walletBalance()).toBe("975.00");
    await expectWalletConsistent(ctx, walletId);
  });

  test("redelivered message (same messageId) is deduplicated by the persistent inbox", async () => {
    const data = wagerData();
    const messageId = uuidv7();
    await sendWagerMessage(queues, data, messageId);
    await sendWagerMessage(queues, data, messageId); // duplicate delivery
    await waitFor(async () => (await debitCount()) === 2);
    // Give the duplicate time to be (not) applied.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await debitCount()).toBe(2);
    expect(await walletBalance()).toBe("950.00");
    await expectWalletConsistent(ctx, walletId);
  });

  test("worker crash after commit and before ack does not duplicate effects on redelivery", async () => {
    const data = wagerData();
    const messageId = uuidv7();

    // Simulate the crashed worker: the use case ran and committed (with the
    // inbox row), but the message was never deleted from the queue.
    await ctx.submit.execute(
      {
        providerId: data.providerId as string,
        externalTransactionId: data.externalTransactionId as string,
        idempotencyKey: data.idempotencyKey as string,
        playerId,
        walletId,
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Bet,
        money: brl("25.00"),
      },
      { correlationId: messageId, inbox: { consumerName: CONSUMER_NAME, messageId } },
    );
    expect(await debitCount()).toBe(3);

    // The broker redelivers; the running consumer must dedupe and ack.
    await sendWagerMessage(queues, data, messageId);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(await debitCount()).toBe(3); // unchanged
    expect(await walletBalance()).toBe("925.00");
    await expectWalletConsistent(ctx, walletId);
  });

  test("business rejection is terminal: message is acked, transaction REJECTED, no retry", async () => {
    const data = wagerData({ money: brl("999999.00") });
    await sendWagerMessage(queues, data);
    await waitFor(async () => {
      const rows = (await ctx.orm.em
        .fork()
        .getConnection()
        .execute(`select status from wager_transactions where external_transaction_id = ?`, [
          data.externalTransactionId,
        ])) as Array<{ status: string }>;
      return rows[0]?.status === "REJECTED";
    });
    await expectWalletConsistent(ctx, walletId);
  });

  test("malformed message goes to the DLQ", async () => {
    const data = wagerData({ money: { amount: "25.001", currency: "BRL" } }); // > 2 decimal places
    await sendWagerMessage(queues, data);
    const bodies = await drainQueue(queues, queues.dlq, 10_000);
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    expect(bodies.some((b) => b.includes(data.externalTransactionId as string))).toBe(true);
  });

  test("unknown kind goes to the DLQ", async () => {
    const data = wagerData({ kind: "OPENING" });
    await sendWagerMessage(queues, data);
    const bodies = await drainQueue(queues, queues.dlq, 10_000);
    expect(bodies.some((b) => b.includes(data.externalTransactionId as string))).toBe(true);
  });
});
