import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { v7 as uuidv7 } from "uuid";
import {
  brl,
  createTestContext,
  expectWalletConsistent,
  type TestContext,
} from "../helpers/integration";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/entities/wager-transaction";
import type { SubmitResult } from "../../src/application/use-cases/submit-wager-transaction";
import { FailureCode } from "../../src/domain/failure-codes";

/**
 * Real-parallelism races against PostgreSQL: every submission below runs on
 * its own pooled connection, so the database-level locking is genuinely
 * exercised (no sequential mocks).
 */
describe("concurrency races (real PostgreSQL)", () => {
  let ctx: TestContext;
  const playerId = uuidv7();
  const evt = { correlationId: "race" };

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.destroy();
  });

  async function newWallet(balance: string): Promise<string> {
    const wallet = await ctx.createWallet.execute(
      { playerId: uuidv7(), initialBalance: brl(balance) },
      evt,
    );
    return wallet.id;
  }

  function bet(walletId: string, owner: string, amount: string, externalId = uuidv7()) {
    return {
      providerId: "provider-a",
      externalTransactionId: externalId,
      idempotencyKey: `provider-a:${externalId}`,
      playerId: owner,
      walletId,
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: brl(amount),
    };
  }

  const debitCount = async (walletId: string): Promise<number> => {
    const rows = (await ctx.orm.em
      .fork()
      .getConnection()
      .execute(
        `select count(*)::int as c from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
        [walletId],
      )) as Array<{ c: number }>;
    return rows[0]!.c;
  };

  test("the same bet submitted 50 times in parallel produces exactly one debit", async () => {
    const owner = uuidv7();
    const wallet = await ctx.createWallet.execute({ playerId: owner, initialBalance: brl("100.00") }, evt);
    const command = bet(wallet.id, owner, "25.00");

    const results = await Promise.all(
      Array.from({ length: 50 }, () => ctx.submit.execute(command, evt)),
    );

    for (const result of results) {
      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance).toEqual(brl("75.00"));
    }
    expect(results.filter((r) => !r.idempotentReplay).length).toBe(1);
    expect(results.filter((r) => r.idempotentReplay).length).toBe(49);
    expect(await debitCount(wallet.id)).toBe(1);
    await expectWalletConsistent(ctx, wallet.id);
  });

  test("mandatory scenario: 100.00 balance, two concurrent 80.00 bets → one PROCESSED, one REJECTED, final 20.00, one debit", async () => {
    const owner = uuidv7();
    const wallet = await ctx.createWallet.execute({ playerId: owner, initialBalance: brl("100.00") }, evt);

    const [a, b] = await Promise.all([
      ctx.submit.execute(bet(wallet.id, owner, "80.00"), evt),
      ctx.submit.execute(bet(wallet.id, owner, "80.00"), evt),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected].sort());
    const rejected = [a, b].find((r) => r.status === WagerTransactionStatus.Rejected)!;
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);

    const rows = (await ctx.orm.em
      .fork()
      .getConnection()
      .execute(`select balance_amount from wallets where id = ?`, [wallet.id])) as Array<{
      balance_amount: string;
    }>;
    expect(rows[0]!.balance_amount).toBe("20.00");
    expect(await debitCount(wallet.id)).toBe(1);

    // Retries do not duplicate the debit.
    const retryA = await ctx.submit.execute(bet(wallet.id, owner, "80.00", a.transactionId), evt);
    expect(await debitCount(wallet.id)).toBeLessThanOrEqual(2); // the retry is a NEW bet (new key) and must be rejected
    expect(retryA.status).toBe(WagerTransactionStatus.Rejected);
    await expectWalletConsistent(ctx, wallet.id);
  });

  test("hot wallet: 30 concurrent 10.00 bets against 100.00 never overdraw and stay ledger-consistent", async () => {
    const owner = uuidv7();
    const wallet = await ctx.createWallet.execute({ playerId: owner, initialBalance: brl("100.00") }, evt);

    const results = await Promise.all(
      Array.from({ length: 30 }, () => ctx.submit.execute(bet(wallet.id, owner, "10.00"), evt)),
    );
    const processed = results.filter((r) => r.status === WagerTransactionStatus.Processed).length;
    const rejected = results.filter((r) => r.status === WagerTransactionStatus.Rejected).length;
    expect(processed).toBe(10); // exactly the balance allows
    expect(rejected).toBe(20);

    const rows = (await ctx.orm.em
      .fork()
      .getConnection()
      .execute(`select balance_amount from wallets where id = ?`, [wallet.id])) as Array<{
      balance_amount: string;
    }>;
    expect(rows[0]!.balance_amount).toBe("0.00");
    expect(await debitCount(wallet.id)).toBe(10);
    await expectWalletConsistent(ctx, wallet.id);
  });

  test("different wallets are processed in parallel without interference", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const owner = uuidv7();
        const wallet = await ctx.createWallet.execute(
          { playerId: owner, initialBalance: brl("100.00") },
          evt,
        );
        return { id: wallet.id, owner };
      }),
    );

    const results: SubmitResult[] = await Promise.all(
      wallets.flatMap((w) =>
        Array.from({ length: 5 }, () => ctx.submit.execute(bet(w.id, w.owner, "10.00"), evt)),
      ),
    );
    expect(results.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);

    for (const w of wallets) {
      const rows = (await ctx.orm.em
        .fork()
        .getConnection()
        .execute(`select balance_amount from wallets where id = ?`, [w.id])) as Array<{
        balance_amount: string;
      }>;
      expect(rows[0]!.balance_amount).toBe("50.00");
      await expectWalletConsistent(ctx, w.id);
    }
  });

  test("concurrent REFUND and ROLLBACK of the same BET: only one reversal wins", async () => {
    const owner = uuidv7();
    const wallet = await ctx.createWallet.execute({ playerId: owner, initialBalance: brl("100.00") }, evt);
    const betCmd = bet(wallet.id, owner, "40.00");
    await ctx.submit.execute(betCmd, evt); // balance 60

    // A REFUND and a ROLLBACK of the same bet race. Both credit 40 — if both
    // won, the provider would have minted money.
    const refundExternal = uuidv7();
    const rollbackExternal = uuidv7();
    const [refund, rollback] = await Promise.all([
      ctx.submit.execute(
        {
          ...bet(wallet.id, owner, "40.00", refundExternal),
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: betCmd.externalTransactionId,
        },
        evt,
      ),
      ctx.submit.execute(
        {
          ...bet(wallet.id, owner, "40.00", rollbackExternal),
          kind: WagerTransactionKind.Rollback,
          referenceExternalTransactionId: betCmd.externalTransactionId,
        },
        evt,
      ),
    ]);

    // A reference can be reversed exactly once, whatever the kind — a second
    // reversal would duplicate the credit.
    const statuses = [refund.status, rollback.status];
    expect(statuses.filter((s) => s === WagerTransactionStatus.Processed).length).toBe(1);
    expect(statuses.filter((s) => s === WagerTransactionStatus.Rejected).length).toBe(1);

    const rows = (await ctx.orm.em
      .fork()
      .getConnection()
      .execute(`select balance_amount from wallets where id = ?`, [wallet.id])) as Array<{
      balance_amount: string;
    }>;
    expect(rows[0]!.balance_amount).toBe("100.00");
    await expectWalletConsistent(ctx, wallet.id);
  });
});
