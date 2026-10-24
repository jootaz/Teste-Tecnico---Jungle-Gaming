import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import {
  brl,
  createTestContext,
  expectWalletConsistent,
  type TestContext,
} from "../helpers/integration";

const RUNNER = join(import.meta.dir, "..", "helpers", "instance-runner.ts");

interface RunnerResult {
  status: string;
  idempotentReplay?: boolean;
  error?: string;
}

async function spawnInstances(
  env: Record<string, string>,
  instances = 3,
): Promise<RunnerResult[]> {
  const procs = Array.from({ length: instances }, () =>
    Bun.spawn(["bun", "run", RUNNER], {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const outputs = await Promise.all(
    procs.map(async (proc) => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        throw new Error(`instance exited with ${exitCode}: ${stderr.slice(0, 2000)}`);
      }
      return stdout;
    }),
  );
  return outputs
    .flatMap((output) => output.split("\n"))
    .filter((line) => line.startsWith("RESULT "))
    .map((line) => JSON.parse(line.slice("RESULT ".length)) as RunnerResult);
}

/**
 * Three real OS processes (plus this test process) hammer the same wallet in
 * the same PostgreSQL database — the strongest version of the multi-instance
 * requirement, no shared memory at all.
 */
describe("multi-instance concurrency (3 real processes, real PostgreSQL)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.destroy();
  });

  const walletRow = async (walletId: string) => {
    const rows = (await ctx.orm.em
      .fork()
      .getConnection()
      .execute(`select balance_amount, version from wallets where id = ?`, [walletId])) as Array<{
      balance_amount: string;
      version: number;
    }>;
    return rows[0]!;
  };

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

  test(
    "the same bet from 3 instances x 15 attempts produces exactly one debit",
    async () => {
      const playerId = uuidv7();
      const wallet = await ctx.createWallet.execute(
        { playerId, initialBalance: brl("100.00") },
        { correlationId: "multi" },
      );

      const results = await spawnInstances({
        DATABASE_URL: ctx.databaseUrl,
        WALLET_ID: wallet.id,
        PLAYER_ID: playerId,
        MODE: "same-bet",
        ATTEMPTS: "15",
        SHARED_EXTERNAL_ID: `shared-${uuidv7()}`,
        AMOUNT: "25.00",
      });

      expect(results.length).toBe(45);
      expect(results.every((r) => r.status === "PROCESSED")).toBe(true);
      expect(results.filter((r) => !r.idempotentReplay).length).toBe(1);

      expect(await debitCount(wallet.id)).toBe(1);
      expect((await walletRow(wallet.id)).balance_amount).toBe("75.00");
      await expectWalletConsistent(ctx, wallet.id);
    },
    { timeout: 120_000 },
  );

  test(
    "3 instances dispute the same balance with distinct bets: never negative, ledger-consistent",
    async () => {
      const playerId = uuidv7();
      const wallet = await ctx.createWallet.execute(
        { playerId, initialBalance: brl("50.00") },
        { correlationId: "multi" },
      );

      // 3 instances x 10 bets of 10.00 = 300.00 attempted against 50.00.
      const results = await spawnInstances({
        DATABASE_URL: ctx.databaseUrl,
        WALLET_ID: wallet.id,
        PLAYER_ID: playerId,
        MODE: "distinct",
        ATTEMPTS: "10",
        AMOUNT: "10.00",
      });

      expect(results.length).toBe(30);
      expect(results.some((r) => r.status === "ERROR")).toBe(false);
      const processed = results.filter((r) => r.status === "PROCESSED").length;
      const rejected = results.filter((r) => r.status === "REJECTED").length;
      expect(processed).toBe(5); // exactly what the balance allows
      expect(rejected).toBe(25);

      const row = await walletRow(wallet.id);
      expect(row.balance_amount).toBe("0.00");
      expect(await debitCount(wallet.id)).toBe(5);
      // opening credit + 5 debits => version 6
      expect(row.version).toBe(6);
      await expectWalletConsistent(ctx, wallet.id);
    },
    { timeout: 120_000 },
  );
});
