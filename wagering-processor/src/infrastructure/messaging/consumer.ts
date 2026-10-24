import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import {
  SubmitWagerTransactionUseCase,
  type SubmitWagerTransactionCommand,
} from "../../application/use-cases/submit-wager-transaction";
import { WagerTransactionKind } from "../../domain/entities/wager-transaction";
import { IdempotencyConflictError, WalletNotFoundError } from "../../application/errors";
import { DomainValidationError } from "../../domain/errors";
import { InvalidMoneyError } from "../../domain/value-objects/money";
import { resolveQueueUrl } from "./sqs";
import type { Logger } from "../observability/logger";
import type { Metrics } from "../observability/metrics";

export const CONSUMER_NAME = "wager-transactions-consumer";

const EXTERNAL_KINDS = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

interface QueueEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

/** Raised for messages that can never be processed — routed to the DLQ. */
class PermanentMessageError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PermanentMessageError";
  }
}

/**
 * SQS consumer for wager-transactions.fifo.
 *
 * - reuses the same use case as the HTTP entry point;
 * - deduplicates through the persistent inbox (consumerName, messageId);
 * - acks (DeleteMessage) only after the SQL transaction committed;
 * - business rejections are terminal outcomes → ack;
 * - transient failures → visibility backoff, redelivery, redrive to DLQ
 *   after maxReceiveCount;
 * - permanent failures (malformed payload, impossible contract) → explicit
 *   DLQ forward + ack;
 * - on SIGTERM finishes the in-flight batch before resolving stop().
 */
export class WagerTransactionsConsumer {
  private running = false;
  private inFlight: Promise<void> = Promise.resolve();
  private abort: AbortController | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
    private readonly dlqName: string,
    private readonly useCase: SubmitWagerTransactionUseCase,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly waitTimeSeconds = 5,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.inFlight = this.loop();
    this.logger.info({ worker: "sqs-consumer", queue: this.queueName }, "consumer started");
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.inFlight;
    this.logger.info({ worker: "sqs-consumer" }, "consumer stopped");
  }

  private async loop(): Promise<void> {
    const queueUrl = await resolveQueueUrl(this.client, this.queueName);
    while (this.running) {
      try {
        this.abort = new AbortController();
        const { Messages } = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.waitTimeSeconds,
            MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
          }),
          { abortSignal: this.abort.signal },
        );
        for (const message of Messages ?? []) {
          // Finish in-flight messages even when a shutdown was requested.
          await this.handleMessage(queueUrl, message);
        }
      } catch (error) {
        if (!this.running) break;
        this.logger.warn({ err: String(error) }, "receive loop error, backing off");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async handleMessage(queueUrl: string, message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    const log = this.logger.child({ sqsMessageId: message.MessageId, receiveCount });
    const stopTimer = this.metrics.processingLatency.startTimer({ source: "sqs" });

    try {
      const envelope = this.parse(message.Body ?? "");
      const command = this.toCommand(envelope);
      const result = await this.useCase.execute(command, {
        correlationId: envelope.messageId,
        causationId: envelope.messageId,
        inbox: { consumerName: CONSUMER_NAME, messageId: envelope.messageId },
      });

      await this.ack(queueUrl, message);
      this.metrics.sqsMessages.inc({ result: result.duplicateMessage ? "duplicate" : "processed" });
      log.info(
        {
          messageId: envelope.messageId,
          transactionId: result.transactionId,
          walletId: command.walletId,
          providerId: command.providerId,
          correlationId: envelope.messageId,
          status: result.status,
          failureCode: result.failureCode,
          duplicate: result.duplicateMessage ?? false,
        },
        "message handled",
      );
    } catch (error) {
      if (this.isPermanent(error)) {
        await this.forwardToDlq(message, String(error));
        await this.ack(queueUrl, message);
        this.metrics.sqsMessages.inc({ result: "dlq" });
        log.error({ err: String(error) }, "permanent failure, message moved to DLQ");
      } else {
        // Transient: leave the message; exponential visibility backoff.
        // After maxReceiveCount the redrive policy moves it to the DLQ.
        const backoffSeconds = Math.min(2 ** receiveCount, 300);
        await this.client
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle!,
              VisibilityTimeout: backoffSeconds,
            }),
          )
          .catch(() => undefined);
        this.metrics.sqsMessages.inc({ result: "retried" });
        log.warn({ err: String(error), backoffSeconds }, "transient failure, message will be redelivered");
      }
    } finally {
      stopTimer();
    }
  }

  private parse(body: string): QueueEnvelope {
    let parsed: QueueEnvelope;
    try {
      parsed = JSON.parse(body) as QueueEnvelope;
    } catch {
      throw new PermanentMessageError("malformed JSON body");
    }
    if (!parsed?.messageId || parsed.type !== "WagerTransactionRequested" || !parsed.data) {
      throw new PermanentMessageError(`unsupported envelope (type=${parsed?.type})`);
    }
    return parsed;
  }

  private toCommand(envelope: QueueEnvelope): SubmitWagerTransactionCommand {
    const { data } = envelope;
    if (!EXTERNAL_KINDS.has(data.kind)) {
      throw new PermanentMessageError(`kind ${data.kind} cannot be submitted through the queue`);
    }
    for (const field of [
      "providerId",
      "externalTransactionId",
      "idempotencyKey",
      "playerId",
      "walletId",
      "roundId",
      "gameId",
    ] as const) {
      if (typeof data[field] !== "string" || data[field].length === 0) {
        throw new PermanentMessageError(`missing field ${field}`);
      }
    }
    return {
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      idempotencyKey: data.idempotencyKey,
      playerId: data.playerId,
      walletId: data.walletId,
      roundId: data.roundId,
      gameId: data.gameId,
      kind: data.kind as WagerTransactionKind,
      money: data.money,
      referenceExternalTransactionId: data.referenceExternalTransactionId,
    };
  }

  private isPermanent(error: unknown): boolean {
    return (
      error instanceof PermanentMessageError ||
      error instanceof InvalidMoneyError ||
      error instanceof DomainValidationError ||
      error instanceof WalletNotFoundError ||
      error instanceof IdempotencyConflictError
    );
  }

  private async forwardToDlq(message: Message, reason: string): Promise<void> {
    const dlqUrl = await resolveQueueUrl(this.client, this.dlqName);
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: JSON.stringify({
          originalBody: message.Body,
          reason,
          failedAt: new Date().toISOString(),
        }),
        MessageGroupId: message.Attributes?.MessageGroupId ?? "dlq",
        MessageDeduplicationId: message.MessageId,
      }),
    );
  }

  private async ack(queueUrl: string, message: Message): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }),
    );
  }
}
