import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import type { MikroORM } from "@mikro-orm/postgresql";
import { GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { AppConfig } from "../infrastructure/config";
import type { Metrics } from "../infrastructure/observability/metrics";
import { TOKENS } from "./tokens";

/** Liveness and readiness. Both endpoints are unauthenticated by design. */
@Controller()
export class HealthController {
  constructor(
    @Inject(TOKENS.Orm) private readonly orm: MikroORM,
    @Inject(TOKENS.SqsClient) private readonly sqs: SQSClient,
    @Inject(TOKENS.Config) private readonly config: AppConfig,
  ) {}

  @Get("/health/live")
  live() {
    return { status: "ok" };
  }

  @Get("/health/ready")
  async ready(@Res() res: Response): Promise<void> {
    const checks: Record<string, string> = {};
    let healthy = true;

    try {
      await this.orm.em.getConnection().execute("select 1");
      checks.postgres = "up";
    } catch {
      checks.postgres = "down";
      healthy = false;
    }

    try {
      await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.transactionsQueue }));
      checks.sqs = "up";
    } catch {
      checks.sqs = "down";
      healthy = false;
    }

    res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", checks });
  }
}

@Controller()
export class MetricsController {
  constructor(@Inject(TOKENS.Metrics) private readonly metrics: Metrics) {}

  @Get("/metrics")
  async metricsEndpoint(@Res() res: Response): Promise<void> {
    res.setHeader("Content-Type", this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}
