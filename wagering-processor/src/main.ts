import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import { AppModule, Workers } from "./app.module";
import { GlobalExceptionFilter } from "./api/http-exception.filter";
import { TOKENS } from "./api/tokens";
import type { Logger } from "./infrastructure/observability/logger";
import type { AppConfig } from "./infrastructure/config";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });

  const logger = app.get<Logger>(TOKENS.Logger);
  const config = app.get<AppConfig>(TOKENS.Config);
  const workers = app.get<Workers>(TOKENS.Workers);
  const orm = app.get<MikroORM>(TOKENS.Orm);

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidUnknownValues: false }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter(logger));

  await app.listen(config.port);
  workers.start();
  logger.info({ port: config.port }, "wagering-processor is up");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "graceful shutdown: draining workers");
    try {
      // Finish in-flight SQS messages / outbox batches before closing.
      await workers.stop();
      await app.close();
      await orm.close(true);
      logger.info("shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error({ err: String(error) }, "shutdown failed");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

bootstrap().catch((error) => {
  console.error("fatal bootstrap error", error);
  process.exit(1);
});
