import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { loadConfig, type AppConfig } from "./infrastructure/config";
import { createLogger, type Logger } from "./infrastructure/observability/logger";
import { Metrics } from "./infrastructure/observability/metrics";
import { initOrm } from "./infrastructure/persistence/orm";
import { MikroOrmUnitOfWork } from "./infrastructure/persistence/unit-of-work";
import { createSqsClient, SqsEventPublisher } from "./infrastructure/messaging/sqs";
import { OutboxPublisher } from "./infrastructure/messaging/outbox-publisher";
import { PendingReferenceWorker } from "./infrastructure/messaging/pending-reference-worker";
import { WagerTransactionsConsumer } from "./infrastructure/messaging/consumer";
import { SubmitWagerTransactionUseCase } from "./application/use-cases/submit-wager-transaction";
import { CreateWalletUseCase } from "./application/use-cases/create-wallet";
import { ReconcileWalletUseCase } from "./application/use-cases/reconcile-wallet";
import { ProcessPendingReferencesUseCase } from "./application/use-cases/process-pending-references";
import { TransactionQueries, WalletQueries } from "./application/use-cases/queries";
import type { UnitOfWork } from "./application/ports";
import { ProvidersController, WageringController, WalletsController } from "./api/controllers";
import { HealthController, MetricsController } from "./api/health.controller";
import { ProviderAuthGuard } from "./api/auth.guard";
import { TOKENS } from "./api/tokens";

/** Background workers lifecycle, started in main.ts and stopped on SIGTERM. */
export class Workers {
  constructor(
    readonly consumer: WagerTransactionsConsumer | undefined,
    readonly outboxPublisher: OutboxPublisher | undefined,
    readonly pendingReferenceWorker: PendingReferenceWorker | undefined,
  ) {}

  start(): void {
    this.consumer?.start();
    this.outboxPublisher?.start();
    this.pendingReferenceWorker?.start();
  }

  async stop(): Promise<void> {
    // Consumer first: stop pulling new work, finish in-flight messages,
    // then let the workers drain.
    await this.consumer?.stop();
    await this.pendingReferenceWorker?.stop();
    await this.outboxPublisher?.stop();
  }
}

@Module({
  controllers: [
    WalletsController,
    WageringController,
    ProvidersController,
    HealthController,
    MetricsController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ProviderAuthGuard },
    { provide: TOKENS.Config, useFactory: loadConfig },
    { provide: TOKENS.Logger, useFactory: createLogger },
    { provide: TOKENS.Metrics, useClass: Metrics },
    {
      provide: TOKENS.Orm,
      useFactory: async (config: AppConfig) => initOrm(config.databaseUrl),
      inject: [TOKENS.Config],
    },
    {
      provide: TOKENS.UnitOfWork,
      useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm),
      inject: [TOKENS.Orm],
    },
    {
      provide: TOKENS.SqsClient,
      useFactory: (config: AppConfig) => createSqsClient(config.sqs.endpoint, config.sqs.region),
      inject: [TOKENS.Config],
    },
    {
      provide: TOKENS.SubmitUseCase,
      useFactory: (uow: UnitOfWork, metrics: Metrics, config: AppConfig) =>
        new SubmitWagerTransactionUseCase(uow, metrics, {
          pendingReferenceMaxAttempts: config.workers.pendingReferenceMaxAttempts,
        }),
      inject: [TOKENS.UnitOfWork, TOKENS.Metrics, TOKENS.Config],
    },
    {
      provide: TOKENS.CreateWalletUseCase,
      useFactory: (uow: UnitOfWork) => new CreateWalletUseCase(uow),
      inject: [TOKENS.UnitOfWork],
    },
    {
      provide: TOKENS.ReconcileWalletUseCase,
      useFactory: (uow: UnitOfWork, metrics: Metrics) => new ReconcileWalletUseCase(uow, metrics),
      inject: [TOKENS.UnitOfWork, TOKENS.Metrics],
    },
    {
      provide: TOKENS.WalletQueries,
      useFactory: (uow: UnitOfWork) => new WalletQueries(uow),
      inject: [TOKENS.UnitOfWork],
    },
    {
      provide: TOKENS.TransactionQueries,
      useFactory: (uow: UnitOfWork) => new TransactionQueries(uow),
      inject: [TOKENS.UnitOfWork],
    },
    {
      provide: TOKENS.Workers,
      useFactory: (
        config: AppConfig,
        uow: UnitOfWork,
        sqs: SQSClient,
        submit: SubmitWagerTransactionUseCase,
        logger: Logger,
        metrics: Metrics,
      ) => {
        const consumer = config.workers.consumerEnabled
          ? new WagerTransactionsConsumer(
              sqs,
              config.sqs.transactionsQueue,
              config.sqs.transactionsDlq,
              submit,
              logger,
              metrics,
              config.sqs.waitTimeSeconds,
            )
          : undefined;
        const outbox = config.workers.outboxEnabled
          ? new OutboxPublisher(
              uow,
              new SqsEventPublisher(sqs, config.sqs.eventsQueue),
              logger,
              metrics,
              config.workers.outboxPollIntervalMs,
              config.workers.outboxBatchSize,
            )
          : undefined;
        const pendingRef = config.workers.pendingReferenceEnabled
          ? new PendingReferenceWorker(
              new ProcessPendingReferencesUseCase(uow, submit),
              logger,
              config.workers.pendingReferencePollIntervalMs,
            )
          : undefined;
        return new Workers(consumer, outbox, pendingRef);
      },
      inject: [
        TOKENS.Config,
        TOKENS.UnitOfWork,
        TOKENS.SqsClient,
        TOKENS.SubmitUseCase,
        TOKENS.Logger,
        TOKENS.Metrics,
      ],
    },
  ],
})
export class AppModule {}
