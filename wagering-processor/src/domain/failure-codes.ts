/**
 * Stable, machine-readable failure taxonomy.
 *
 * Providers use these codes to decide whether to resend (transient),
 * fix the payload (validation/context) or give up (terminal business rule).
 * The full taxonomy is documented in ARCHITECTURE.md.
 */
export enum FailureCode {
  // Business rejections (terminal — fixing the payload will not help)
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceKindMismatch = "REFERENCE_KIND_MISMATCH",
  ReferenceContextMismatch = "REFERENCE_CONTEXT_MISMATCH",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletNotFound = "WALLET_NOT_FOUND",
  PlayerWalletMismatch = "PLAYER_WALLET_MISMATCH",

  // Contract-level failures (fix the request)
  ValidationFailed = "VALIDATION_FAILED",
  IdempotencyPayloadMismatch = "IDEMPOTENCY_PAYLOAD_MISMATCH",
  KindNotSubmittable = "KIND_NOT_SUBMITTABLE",

  // Infrastructure (auditable permanent failures)
  PermanentInfrastructureError = "PERMANENT_INFRASTRUCTURE_ERROR",
}
