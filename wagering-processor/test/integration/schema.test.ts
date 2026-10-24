import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { v7 as uuidv7 } from "uuid";
import { createTestContext, type TestContext } from "../helpers/integration";

/**
 * Migrations and schema-level constraints: the invariants must hold in the
 * database itself, independent of application code.
 */
describe("schema constraints (real PostgreSQL)", () => {
  let ctx: TestContext;
  const exec = (sql: string, params: unknown[] = []) =>
    ctx.orm.em.fork().getConnection().execute(sql, params);

  beforeAll(async () => {
    ctx = await createTestContext(); // runs the migrations
  });

  afterAll(async () => {
    await ctx.destroy();
  });

  async function insertWallet(balance = "100.00"): Promise<string> {
    const id = uuidv7();
    await exec(
      `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       values (?, ?, 'BRL', ?, 1, now(), now())`,
      [id, uuidv7(), balance],
    );
    return id;
  }

  async function insertTransaction(walletId: string, kind = "BET", status = "PROCESSED"): Promise<string> {
    const id = uuidv7();
    await exec(
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
          player_id, round_id, game_id, kind, amount, currency, status, reference_retry_attempts, created_at)
       values (?, 'p', ?, ?, 'h', ?, ?, 'r', 'g', ?, '10.00', 'BRL', ?, 0, now())`,
      [id, uuidv7(), uuidv7(), walletId, uuidv7(), kind, status],
    );
    return id;
  }

  test("negative balance is rejected by CHECK constraint", async () => {
    const walletId = await insertWallet();
    await expect(
      exec(`update wallets set balance_amount = '-0.01' where id = ?`, [walletId]),
    ).rejects.toThrow();
  });

  test("duplicate wallet per (player, currency) is rejected", async () => {
    const playerId = uuidv7();
    await exec(
      `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       values (?, ?, 'BRL', '0.00', 1, now(), now())`,
      [uuidv7(), playerId],
    );
    await expect(
      exec(
        `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
         values (?, ?, 'BRL', '0.00', 1, now(), now())`,
        [uuidv7(), playerId],
      ),
    ).rejects.toThrow();
  });

  test("duplicate (provider, external id) and (provider, idempotency key) are rejected", async () => {
    const walletId = await insertWallet();
    const externalId = uuidv7();
    const idemKey = uuidv7();
    await exec(
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
          player_id, round_id, game_id, kind, amount, currency, status, reference_retry_attempts, created_at)
       values (?, 'p', ?, ?, 'h', ?, ?, 'r', 'g', 'BET', '10.00', 'BRL', 'PENDING', 0, now())`,
      [uuidv7(), externalId, idemKey, walletId, uuidv7()],
    );
    await expect(
      exec(
        `insert into wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
            player_id, round_id, game_id, kind, amount, currency, status, reference_retry_attempts, created_at)
         values (?, 'p', ?, ?, 'h', ?, ?, 'r', 'g', 'BET', '10.00', 'BRL', 'PENDING', 0, now())`,
        [uuidv7(), externalId, uuidv7(), walletId, uuidv7()],
      ),
    ).rejects.toThrow();
    await expect(
      exec(
        `insert into wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
            player_id, round_id, game_id, kind, amount, currency, status, reference_retry_attempts, created_at)
         values (?, 'p', ?, ?, 'h', ?, ?, 'r', 'g', 'BET', '10.00', 'BRL', 'PENDING', 0, now())`,
        [uuidv7(), uuidv7(), idemKey, walletId, uuidv7()],
      ),
    ).rejects.toThrow();
  });

  test("ledger arithmetic CHECK rejects unbalanced entries", async () => {
    const walletId = await insertWallet();
    const txId = await insertTransaction(walletId);
    await expect(
      exec(
        `insert into wallet_ledger_entries
           (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         values (?, ?, ?, 'DEBIT', '10.00', 'BRL', '100.00', '95.00', now())`,
        [uuidv7(), walletId, txId],
      ),
    ).rejects.toThrow();
  });

  test("ledger is append-only: UPDATE and DELETE are blocked by trigger", async () => {
    const walletId = await insertWallet();
    const txId = await insertTransaction(walletId);
    const entryId = uuidv7();
    await exec(
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, 'DEBIT', '10.00', 'BRL', '100.00', '90.00', now())`,
      [entryId, walletId, txId],
    );
    await expect(
      exec(`update wallet_ledger_entries set amount = '11.00' where id = ?`, [entryId]),
    ).rejects.toThrow();
    await expect(exec(`delete from wallet_ledger_entries where id = ?`, [entryId])).rejects.toThrow();
  });

  test("a second ledger entry for the same transaction is rejected", async () => {
    const walletId = await insertWallet();
    const txId = await insertTransaction(walletId);
    await exec(
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, 'DEBIT', '10.00', 'BRL', '100.00', '90.00', now())`,
      [uuidv7(), walletId, txId],
    );
    await expect(
      exec(
        `insert into wallet_ledger_entries
           (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         values (?, ?, ?, 'DEBIT', '10.00', 'BRL', '90.00', '80.00', now())`,
        [uuidv7(), walletId, txId],
      ),
    ).rejects.toThrow();
  });

  test("a second PROCESSED reversal of the same reference is rejected by the partial unique index", async () => {
    const walletId = await insertWallet();
    const betId = await insertTransaction(walletId, "BET", "PROCESSED");
    const insertReversal = (kind: string, status: string) =>
      exec(
        `insert into wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
            player_id, round_id, game_id, kind, amount, currency, status, reference_transaction_id,
            reference_retry_attempts, created_at)
         values (?, 'p', ?, ?, 'h', ?, ?, 'r', 'g', ?, '10.00', 'BRL', ?, ?, 0, now())`,
        [uuidv7(), uuidv7(), uuidv7(), walletId, uuidv7(), kind, status, betId],
      );
    await insertReversal("REFUND", "PROCESSED");
    // Same kind and different kind are both blocked: one reversal per reference.
    await expect(insertReversal("REFUND", "PROCESSED")).rejects.toThrow();
    await expect(insertReversal("ROLLBACK", "PROCESSED")).rejects.toThrow();
    // A REJECTED attempt does not consume the slot.
    await insertReversal("ROLLBACK", "REJECTED");
  });

  test("migrations are reversible (down + up)", async () => {
    const migrator = ctx.orm.getMigrator();
    await migrator.down();
    const tables = (await exec(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name = 'wallets'`,
    )) as unknown[];
    expect(tables.length).toBe(0);
    await migrator.up();
    const tablesAfter = (await exec(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name = 'wallets'`,
    )) as unknown[];
    expect(tablesAfter.length).toBe(1);
  });
});
