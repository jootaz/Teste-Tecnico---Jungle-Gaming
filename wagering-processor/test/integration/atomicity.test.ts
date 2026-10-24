import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { v7 as uuidv7 } from "uuid";
import {
  brl,
  createTestContext,
  expectWalletConsistent,
  type TestContext,
} from "../helpers/integration";
import { InboxMessage } from "../../src/domain/entities/inbox-message";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/entities/wager-transaction";

describe("unit-of-work atomicity (real PostgreSQL)", () => {
  let ctx: TestContext;
  let walletId: string;
  const playerId = uuidv7();
  const ctxEvt = { correlationId: "test" };

  beforeAll(async () => {
    ctx = await createTestContext();
    const wallet = await ctx.createWallet.execute({ playerId, initialBalance: brl("100.00") }, ctxEvt);
    walletId = wallet.id;
  });

  afterAll(async () => {
    await ctx.destroy();
  });

  const count = async (table: string): Promise<number> => {
    const rows = (await ctx.orm.em
      .fork()
      .getConnection()
      .execute(`select count(*)::int as c from ${table}`)) as Array<{ c: number }>;
    return rows[0]!.c;
  };

  test("wallet creation is atomic: wallet + OPENING + ledger + outbox", async () => {
    const em = ctx.orm.em.fork().getConnection();
    const wallets = (await em.execute(`select * from wallets where id = ?`, [walletId])) as Array<{
      balance_amount: string;
      version: number;
    }>;
    expect(wallets[0]!.balance_amount).toBe("100.00");
    expect(wallets[0]!.version).toBe(1);

    const txs = (await em.execute(
      `select * from wager_transactions where wallet_id = ? and kind = 'OPENING'`,
      [walletId],
    )) as Array<{ status: string }>;
    expect(txs.length).toBe(1);
    expect(txs[0]!.status).toBe("PROCESSED");

    const entries = (await em.execute(
      `select * from wallet_ledger_entries where wallet_id = ?`,
      [walletId],
    )) as unknown[];
    expect(entries.length).toBe(1);

    const outbox = (await em.execute(`select event_type from outbox_messages`)) as Array<{
      event_type: string;
    }>;
    expect(outbox.map((o) => o.event_type)).toContain("WalletBalanceChanged");
  });

  test("a failure inside the unit of work rolls back inbox, transaction, balance, ledger and outbox together", async () => {
    const before = {
      tx: await count("wager_transactions"),
      ledger: await count("wallet_ledger_entries"),
      inbox: await count("inbox_messages"),
      outbox: await count("outbox_messages"),
    };

    const { Money } = await import("../../src/domain/value-objects/money");
    const { WalletLedgerEntry, LedgerDirection } = await import(
      "../../src/domain/entities/wallet-ledger-entry"
    );
    const { WagerTransaction } = await import("../../src/domain/entities/wager-transaction");
    const { OutboxMessage } = await import("../../src/domain/entities/outbox-message");
    const { WagerTransactionProcessed } = await import("../../src/domain/events/wagering-events");

    await expect(
      ctx.uow.run(async (repos) => {
        await repos.inbox.tryInsert(
          InboxMessage.receive({ messageId: "m-rollback", consumerName: "c", payloadHash: "h" }),
        );
        const wallet = (await repos.wallets.findByIdForUpdate(walletId))!;
        const money = Money.from(brl("10.00"));
        const transaction = WagerTransaction.create({
          id: uuidv7(),
          providerId: "provider-a",
          externalTransactionId: uuidv7(),
          idempotencyKey: uuidv7(),
          payloadHash: "h",
          walletId,
          playerId,
          roundId: "r",
          gameId: "g",
          kind: WagerTransactionKind.Bet,
          money,
        });
        await repos.transactions.insert(transaction);
        const movement = wallet.debit(money);
        await repos.wallets.update(wallet);
        await repos.ledger.insert(
          WalletLedgerEntry.create({
            id: uuidv7(),
            walletId,
            transactionId: transaction.id,
            direction: LedgerDirection.Debit,
            money,
            balanceBefore: movement.balanceBefore,
            balanceAfter: movement.balanceAfter,
          }),
        );
        transaction.markProcessed(undefined, new Date(), wallet.balance);
        await repos.transactions.update(transaction);
        await repos.outbox.insert([
          OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, ctxEvt)),
        ]);
        // Everything above is written — the crash below must undo it all.
        throw new Error("boom before commit");
      }),
    ).rejects.toThrow("boom before commit");

    expect(await count("wager_transactions")).toBe(before.tx);
    expect(await count("wallet_ledger_entries")).toBe(before.ledger);
    expect(await count("inbox_messages")).toBe(before.inbox);
    expect(await count("outbox_messages")).toBe(before.outbox);

    const rows = (await ctx.orm.em
      .fork()
      .getConnection()
      .execute(`select balance_amount from wallets where id = ?`, [walletId])) as Array<{
      balance_amount: string;
    }>;
    expect(rows[0]!.balance_amount).toBe("100.00"); // debit rolled back
    await expectWalletConsistent(ctx, walletId);
  });

  test("submit commits transaction, balance, ledger and outbox atomically", async () => {
    const externalId = uuidv7();
    const result = await ctx.submit.execute(
      {
        providerId: "provider-a",
        externalTransactionId: externalId,
        idempotencyKey: `provider-a:${externalId}`,
        playerId,
        walletId,
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Bet,
        money: brl("25.00"),
      },
      ctxEvt,
    );
    expect(result.status).toBe(WagerTransactionStatus.Processed);

    const em = ctx.orm.em.fork().getConnection();
    const entries = (await em.execute(
      `select l.* from wallet_ledger_entries l
       join wager_transactions t on t.id = l.transaction_id
       where t.external_transaction_id = ?`,
      [externalId],
    )) as Array<{ direction: string; amount: string }>;
    expect(entries.length).toBe(1);
    expect(entries[0]!.direction).toBe("DEBIT");

    const outbox = (await em.execute(
      `select event_type from outbox_messages where published_at is null`,
    )) as Array<{ event_type: string }>;
    expect(outbox.map((o) => o.event_type)).toContain("WagerTransactionProcessed");
    await expectWalletConsistent(ctx, walletId);
  });

  test("service restart: a fresh process sees a consistent wallet and ledger", async () => {
    // Simulate a restart: brand-new ORM (new pool, no identity map) reads the
    // state written by the "previous" process and reconciles it.
    const { MikroORM } = await import("@mikro-orm/postgresql");
    const { buildOrmConfig } = await import("../../src/infrastructure/persistence/orm");
    const { MikroOrmUnitOfWork } = await import("../../src/infrastructure/persistence/unit-of-work");
    const { ReconcileWalletUseCase } = await import(
      "../../src/application/use-cases/reconcile-wallet"
    );

    const freshOrm = await MikroORM.init(buildOrmConfig(ctx.databaseUrl));
    try {
      const result = await new ReconcileWalletUseCase(new MikroOrmUnitOfWork(freshOrm)).execute(
        walletId,
      );
      expect(result.consistent).toBe(true);
      expect(result.difference.amount).toBe("0.00");
      expect(result.checkedEntries).toBeGreaterThan(0);
    } finally {
      await freshOrm.close(true);
    }
  });
});
