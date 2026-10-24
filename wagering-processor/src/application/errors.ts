import { FailureCode } from "../domain/failure-codes";

/** Same Idempotency-Key with a different business payload — conflict, not replay. */
export class IdempotencyConflictError extends Error {
  readonly failureCode = FailureCode.IdempotencyPayloadMismatch;
  constructor(public readonly idempotencyKey: string) {
    super(`idempotency key "${idempotencyKey}" was already used with a different payload`);
    this.name = "IdempotencyConflictError";
  }
}

/** Target wallet does not exist — contract error, nothing is persisted. */
export class WalletNotFoundError extends Error {
  readonly failureCode = FailureCode.WalletNotFound;
  constructor(public readonly walletId: string) {
    super(`wallet ${walletId} not found`);
    this.name = "WalletNotFoundError";
  }
}

/** A wallet for (playerId, currency) already exists. */
export class WalletAlreadyExistsError extends Error {
  constructor(
    public readonly playerId: string,
    public readonly currency: string,
  ) {
    super(`wallet for player ${playerId} and currency ${currency} already exists`);
    this.name = "WalletAlreadyExistsError";
  }
}

export class TransactionNotFoundError extends Error {
  constructor(ref: string) {
    super(`transaction ${ref} not found`);
    this.name = "TransactionNotFoundError";
  }
}
