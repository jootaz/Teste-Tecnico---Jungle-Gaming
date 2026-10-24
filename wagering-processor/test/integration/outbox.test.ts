import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { v7 as uuidv7 } from "uuid";
import {
  brl,
  createTestContext,
  createTestQueues,
  drainQueue,
  waitFor,
  type TestContext,
  type TestQueues,
} from "../helpers/integration";
import { OutboxPublisher } from "../../src/infrastructure/messaging/outbox-publisher";
import { SqsEventPublisher } from "../../src/infrastructure/messaging/sqs";
import { createLogger } from "../../src/infrastructure/observability/logger";
import { Metrics } from "../../src/infrastructure/observability/metrics";
import { WagerTransactionKind } from "../../src/domain/entities/wager-transaction";
import type { EventPublisher } from "../../src/application/ports";

describe("transactional outbox (real LocalStack + PostgreSQL)", () => {
  let ctx: TestContext;
  let queues: TestQueues;
  let walletId: string;
  const playerId = uuidv7();

  beforeAll(async () => {
    ctx = await createTestContext();
    queues = await createTestQueues();
    const wallet = await ctx.createWallet.execute(
      { playerId, initialBalance: brl("1000.00") },
      { correlationId: "t" },
    );
    walletId = wallet.id;
  });

  afterAll(async () => {
    await ctx.destroy();
  });

  async function submitBet(amount = "10.00"): Promise<void> {
    const externalId = uuidv7();
    await ctx.submit.execute(
      {
        providerId: "provider-a",
        externalTransactionId: externalId,
        idempotencyKey: `provider-a:${externalId}`,
        playerId,
        walletId,
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Bet,
        money: brl(amount),
      },
      { correlationId: externalId },
    );
  }

  const pendingOutbox = async (): Promise<number> => {
    const rows = (await ctx.orm.em
      .fork()
      .getConnection()
      .execute(`select count(*)::int as c from outbox_messages where published_at is null`)) as Array<{
      c: number;
    }>;
    return rows[0]!.c;
  };

  function makePublisher(target: EventPublisher = new SqsEventPublisher(queues.client, queues.events)) {
    return new OutboxPublisher(ctx.uow, target, createLogger(), new Metrics(), 100, 10);
  }

  test("crash recovery: events committed by a dead instance are published by another one", async () => {
    // Phase 1: the financial transaction commits, the process "dies" before
    // publishing — no publisher is running at all.
    await submitBet();
    const pendingBefore = await pendingOutbox();
    expect(pendingBefore).toBeGreaterThan(0);

    // Phase 2: a different instance picks up the work.
    const publisher = makePublisher();
    await publisher.tick();
    expect(await pendingOutbox()).toBe(0);

    const bodies = await drainQueue(queues, queues.events, 10_000);
    const types = bodies.map((b) => (JSON.parse(b) as { eventType: string }).eventType);
    expect(types).toContain("WagerTransactionProcessed");
    expect(types).toContain("WalletBalanceChanged");
  });

  test("two concurrent publishers over the same outbox: nothing lost, SKIP LOCKED prevents overlap", async () => {
    for (let i = 0; i < 10; i++) await submitBet("1.00");
    const pending = await pendingOutbox();
    expect(pending).toBeGreaterThanOrEqual(20); // 2 events per bet

    const a = makePublisher();
    const b = makePublisher();
    // Run both "instances" concurrently until the outbox drains.
    await waitFor(async () => {
      await Promise.all([a.tick(), b.tick()]);
      return (await pendingOutbox()) === 0;
    }, 30_000);

    const bodies = await drainQueue(queues, queues.events, 10_000);
    const eventIds = bodies.map((body) => (JSON.parse(body) as { eventId: string }).eventId);
    // At-least-once: every committed event came out; duplicates are allowed
    // but each eventId must appear.
    expect(new Set(eventIds).size).toBeGreaterThanOrEqual(pending);
  });

  test("publish failure schedules a retry with backoff instead of losing the event", async () => {
    await submitBet();
    const failing: EventPublisher = {
      async publish() {
        throw new Error("sqs unavailable");
      },
    };
    const publisher = makePublisher(failing);
    await publisher.tick();

    const rows = (await ctx.orm.em
      .fork()
      .getConnection()
      .execute(
        `select attempts, next_attempt_at from outbox_messages where published_at is null and attempts > 0`,
      )) as Array<{ attempts: number; next_attempt_at: Date }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.attempts).toBeGreaterThanOrEqual(1);
    expect(new Date(rows[0]!.next_attempt_at).getTime()).toBeGreaterThan(Date.now() - 1000);

    // Recovery: a healthy publisher drains everything once messages are due.
    await waitFor(async () => {
      const healthy = makePublisher();
      await healthy.tick();
      return (await pendingOutbox()) === 0;
    }, 30_000);
  });
});
