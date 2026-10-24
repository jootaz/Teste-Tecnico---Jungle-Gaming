import { Migration } from "@mikro-orm/migrations";

/**
 * Initial schema. The invariants the challenge requires are enforced here,
 * not only in application code:
 *
 * - one wallet per (player_id, currency)            → UNIQUE constraint
 * - balance never negative                          → CHECK constraint
 * - idempotency / external id uniqueness            → UNIQUE constraints
 * - single reversal per reference and kind          → partial UNIQUE index
 * - at most one ledger entry per transaction        → UNIQUE constraint
 * - ledger arithmetic (before ± amount = after)     → CHECK constraint
 * - ledger immutability (append-only)               → BEFORE UPDATE/DELETE trigger
 * - inbox dedup per (consumer_name, message_id)     → composite PK
 */
export class Migration20261023000001_initial_schema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance_amount numeric(18,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_balance_non_negative check (balance_amount >= 0),
        constraint wallets_player_currency_unique unique (player_id, currency)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null references wallets (id),
        player_id uuid not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(18,2) not null,
        currency char(3) not null,
        reference_external_transaction_id text null,
        reference_transaction_id uuid null references wager_transactions (id),
        status text not null,
        failure_code text null,
        observed_balance numeric(18,2) null,
        reference_retry_attempts integer not null default 0,
        next_reference_retry_at timestamptz null,
        created_at timestamptz not null,
        processed_at timestamptz null,
        constraint wager_tx_amount_positive check (amount > 0),
        constraint wager_tx_kind_valid check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint wager_tx_status_valid check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint wager_tx_provider_external_unique unique (provider_id, external_transaction_id),
        constraint wager_tx_provider_idempotency_unique unique (provider_id, idempotency_key)
      );
    `);

    // Stricter than "once per kind": allowing a REFUND and a ROLLBACK of the
    // same reference would duplicate the credit, so a reference can be
    // reversed exactly once (documented interpretation — ARCHITECTURE.md).
    this.addSql(`
      create unique index wager_tx_single_reversal
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');
    `);

    this.addSql(`
      create index wager_tx_pending_reference_due
        on wager_transactions (next_reference_retry_at)
        where status = 'PENDING_REFERENCE';
    `);

    this.addSql(`create index wager_tx_wallet_idx on wager_transactions (wallet_id);`);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null references wallets (id),
        transaction_id uuid not null references wager_transactions (id),
        direction text not null,
        amount numeric(18,2) not null,
        currency char(3) not null,
        balance_before numeric(18,2) not null,
        balance_after numeric(18,2) not null,
        created_at timestamptz not null,
        constraint ledger_direction_valid check (direction in ('DEBIT','CREDIT')),
        constraint ledger_amount_positive check (amount > 0),
        constraint ledger_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
        constraint ledger_transaction_unique unique (transaction_id),
        constraint ledger_arithmetic check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT'  and balance_after = balance_before - amount)
        )
      );
    `);

    this.addSql(`create index ledger_wallet_cursor_idx on wallet_ledger_entries (wallet_id, id);`);

    this.addSql(`
      create or replace function forbid_ledger_mutation() returns trigger as $$
      begin
        raise exception 'wallet_ledger_entries is append-only';
      end;
      $$ language plpgsql;
    `);

    this.addSql(`
      create trigger ledger_append_only
        before update or delete on wallet_ledger_entries
        for each row execute function forbid_ledger_mutation();
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz null,
        primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz null,
        published_at timestamptz null
      );
    `);

    this.addSql(`
      create index outbox_pending_due_idx
        on outbox_messages (next_attempt_at)
        where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop trigger if exists ledger_append_only on wallet_ledger_entries;`);
    this.addSql(`drop function if exists forbid_ledger_mutation;`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop table if exists wallets;`);
  }
}
