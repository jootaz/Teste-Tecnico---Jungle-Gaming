import { FailureCode } from "./failure-codes";

/** Base class for all domain errors. */
export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A business-rule violation: the transaction is rejected, recorded and
 * auditable. Never a retryable condition.
 */
export class BusinessRuleViolationError extends DomainError {
  constructor(
    public readonly failureCode: FailureCode,
    message: string,
  ) {
    super(message);
  }
}

/** Attempted transition on a terminal transaction — a programming error. */
export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

/** Invalid construction of a domain object (bad input contract). */
export class DomainValidationError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}
