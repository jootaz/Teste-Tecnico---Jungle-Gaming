import {
  SQSClient,
  GetQueueUrlCommand,
  SendMessageCommand,
  CreateQueueCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import type { EventPublisher } from "../../application/ports";

export function createSqsClient(endpoint: string, region: string): SQSClient {
  return new SQSClient({
    endpoint,
    region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  });
}

const queueUrlCache = new Map<string, string>();

export async function resolveQueueUrl(client: SQSClient, queueName: string): Promise<string> {
  const cached = queueUrlCache.get(queueName);
  if (cached) return cached;
  const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (!QueueUrl) throw new Error(`queue ${queueName} not found`);
  queueUrlCache.set(queueName, QueueUrl);
  return QueueUrl;
}

/** Test/bootstrap helper — production queues are created by LocalStack init. */
export async function ensureQueues(
  client: SQSClient,
  names: { transactions: string; dlq: string; events: string },
  maxReceiveCount = 5,
): Promise<void> {
  const { QueueUrl: dlqUrl } = await client.send(
    new CreateQueueCommand({
      QueueName: names.dlq,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
    }),
  );
  const attrs = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl!, AttributeNames: ["QueueArn"] }),
  );
  await client.send(
    new CreateQueueCommand({
      QueueName: names.transactions,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        VisibilityTimeout: "30",
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: attrs.Attributes!.QueueArn,
          maxReceiveCount: String(maxReceiveCount),
        }),
      },
    }),
  );
  await client.send(new CreateQueueCommand({ QueueName: names.events }));
}

/**
 * Publishes integration-event envelopes to the (standard) events queue.
 * Used exclusively by the outbox worker — never inside a SQL transaction
 * boundary that has not committed the financial change (the outbox pattern
 * guarantees events only exist after that commit).
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
  ) {}

  async publish(envelope: Readonly<Record<string, unknown>>): Promise<void> {
    const queueUrl = await resolveQueueUrl(this.client, this.queueName);
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(envelope),
      }),
    );
  }
}
