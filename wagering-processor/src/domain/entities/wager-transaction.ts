import { Money } from "../value-objects/money";
import { DomainValidationError, InvalidTransactionStateError } from "../errors";
import { FailureCode } from "../failure-codes";
import { LedgerDirection } from "./wallet-ledger-entry";

export enum WagerTransactionKind {
  Opening = "OPENING", // internal: wallet opening credit
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING", // accepted, not yet applied
  PendingReference = "PENDING_REFERENCE", // waiting for the referenced transaction
  Processed = "PROCESSED", // applied (terminal)
  Rejected = "REJECTED", // business-rule violation (terminal)
  Failed = "FAILED", // permanent infrastructure error (terminal, auditable)
}

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState extends Omit<CreateWagerTransactionProps, "createdAt"> {
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: Money;
  referenceRetryAttempts: number;
  nextReferenceRetryAt?: Date;
}

/**
 * A single provider operation over a wallet.
 *
 * Valid transitions:
 *
 *   PENDING ──────────────► PROCESSED | REJECTED | FAILED
 *   PENDING ──────────────► PENDING_REFERENCE
 *   PENDING_REFERENCE ────► PROCESSED | REJECTED | FAILED
 *
 * PROCESSED, REJECTED and FAILED are terminal; transitioning out of them
 * throws InvalidTransactionStateError (a programming error, not a business path).
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** provider-side id — not the internal id */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    /** wallet balance observed when the transaction reached a terminal state (for idempotent replays) */
    private _observedBalance?: Money,
    private _referenceRetryAttempts: number = 0,
    private _nextReferenceRetryAt?: Date,
  ) {}

  /** Born in PENDING. Validates the per-kind reference requirement. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new DomainValidationError(
        "OPENING is internal and cannot be submitted through the API or the queue",
      );
    }
    return WagerTransaction.build(props);
  }

  /** Internal factory for the wallet-opening credit. */
  static createOpening(props: Omit<CreateWagerTransactionProps, "kind">): WagerTransaction {
    return WagerTransaction.build({ ...props, kind: WagerTransactionKind.Opening });
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new DomainValidationError("transaction amount must be positive");
    }
    const requiresRef =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (requiresRef && !props.referenceExternalTransactionId) {
      throw new DomainValidationError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (!requiresRef && props.kind !== WagerTransactionKind.Win && props.referenceExternalTransactionId) {
      throw new DomainValidationError(`${props.kind} must not carry a reference`);
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  /** Rebuilds persisted state — performs no transition validation. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
      state.referenceRetryAttempts,
      state.nextReferenceRetryAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get referenceRetryAttempts(): number {
    return this._referenceRetryAttempts;
  }

  get nextReferenceRetryAt(): Date | undefined {
    return this._nextReferenceRetryAt;
  }

  // ---- transitions ---------------------------------------------------------

  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance: Money): void {
    this.assertNotTerminal("markProcessed");
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._status = WagerTransactionStatus.Processed;
    this._nextReferenceRetryAt = undefined;
  }

  markPendingReference(): void {
    this.assertNotTerminal("markPendingReference");
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode, observedBalance?: Money): void {
    this.assertNotTerminal("reject");
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._processedAt = new Date();
    this._status = WagerTransactionStatus.Rejected;
    this._nextReferenceRetryAt = undefined;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal("fail");
    this._failureCode = code;
    this._processedAt = new Date();
    this._status = WagerTransactionStatus.Failed;
    this._nextReferenceRetryAt = undefined;
  }

  /** Exponential backoff for PENDING_REFERENCE reprocessing. */
  scheduleReferenceRetry(now: Date, baseDelayMs = 1000, maxDelayMs = 60_000): void {
    this.assertNotTerminal("scheduleReferenceRetry");
    this._referenceRetryAttempts += 1;
    const delay = Math.min(baseDelayMs * 2 ** (this._referenceRetryAttempts - 1), maxDelayMs);
    this._nextReferenceRetryAt = new Date(now.getTime() + delay);
  }

  // ---- domain queries ------------------------------------------------------

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** false for LOSS — it records the outcome without moving funds. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Ledger direction produced by this transaction.
   * ROLLBACK inverts the direction of the referenced transaction.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new DomainValidationError("ROLLBACK requires the referenced transaction to derive direction");
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new DomainValidationError("LOSS does not produce a ledger entry");
    }
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `cannot ${transition} transaction ${this.id}: status ${this._status} is terminal`,
      );
    }
  }
}
