/** DI tokens for the composition root. */
export const TOKENS = {
  Config: "CONFIG",
  Logger: "LOGGER",
  Orm: "ORM",
  UnitOfWork: "UNIT_OF_WORK",
  Metrics: "METRICS",
  SqsClient: "SQS_CLIENT",
  SubmitUseCase: "SUBMIT_USE_CASE",
  CreateWalletUseCase: "CREATE_WALLET_USE_CASE",
  ReconcileWalletUseCase: "RECONCILE_WALLET_USE_CASE",
  WalletQueries: "WALLET_QUERIES",
  TransactionQueries: "TRANSACTION_QUERIES",
  Workers: "WORKERS",
} as const;
