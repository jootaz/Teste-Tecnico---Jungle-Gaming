import { MikroORM } from "@mikro-orm/postgresql";
import {
  SendMessageCommand,
  ReceiveMessageCommand,
  PurgeQueueCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { v7 as uuidv7 } from "uuid";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/unit-of-work";
import { createSqsClient, ensureQueues, resolveQueueUrl } from "../../src/infrastructure/messaging/sqs";
import { SubmitWagerTransactionUseCase } from "../../src/application/use-cases/submit-wager-transaction";
import { CreateWalletUseCase } from "../../src/application/use-cases/create-wallet";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet";
import { expect } from "bun:test";

/**
 * Integration/concurrency test context backed by REAL PostgreSQL and
 * LocalStack (docker compose up postgres localstack). Each context gets its
 * own database and its own SQS queues, so test files are isolated.
 */

const PG_BASE = process.env.TEST_DATABASE_URL ?? "postgresql://wagering:wagering@localhost:5432";
export const SQS_ENDPOINT = process.env.TEST_SQS_ENDPOINT ?? "http://localhost:4566";

export interface TestContext {
  orm: MikroORM;
  uow: MikroOrmUnitOfWork;
  submit: SubmitWagerTransactionUseCase;
  createWallet: CreateWalletUseCase;
  reconcile: ReconcileWalletUseCase;
  dbName: string;
  databaseUrl: string;
  destroy(): Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const dbName = `wagering_test_${uuidv7().replaceAll("-", "")}`;
  const admin = await MikroORM.init(buildOrmConfig(`${PG_BASE}/postgres`));
  await admin.em.getConnection().execute(`create database "${dbName}"`);
  await admin.close(true);

  const databaseUrl = `${PG_BASE}/${dbName}`;
  const orm = await MikroORM.init(buildOrmConfig(databaseUrl));
  await orm.getMigrator().up();

  const uow = new MikroOrmUnitOfWork(orm);
  return {
    orm,
    uow,
    submit: new SubmitWagerTransactionUseCase(uow),
    createWallet: new CreateWalletUseCase(uow),
    reconcile: new ReconcileWalletUseCase(uow),
    dbName,
    databaseUrl,
    async destroy() {
      await orm.close(true);
      const admin2 = await MikroORM.init(buildOrmConfig(`${PG_BASE}/postgres`));
      await admin2.em
        .getConnection()
        .execute(`drop database if exists "${dbName}" with (force)`);
      await admin2.close(true);
    },
  };
}

export interface TestQueues {
  client: ReturnType<typeof createSqsClient>;
  transactions: string;
  dlq: string;
  events: string;
}

export async function createTestQueues(maxReceiveCount = 3): Promise<TestQueues> {
  const suffix = uuidv7().slice(-12);
  const client = createSqsClient(SQS_ENDPOINT, "us-east-1");
  const names = {
    transactions: `wager-transactions-test-${suffix}.fifo`,
    dlq: `wager-transactions-dlq-test-${suffix}.fifo`,
    events: `wager-events-test-${suffix}`,
  };
  await ensureQueues(client, names, maxReceiveCount);
  return { client, ...names };
}

export async function sendWagerMessage(
  queues: TestQueues,
  data: Record<string, unknown>,
  messageId = uuidv7(),
): Promise<string> {
  const url = await resolveQueueUrl(queues.client, queues.transactions);
  await queues.client.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: JSON.stringify({
        messageId,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data,
      }),
      MessageGroupId: (data.walletId as string) ?? "test",
      MessageDeduplicationId: `${messageId}-${uuidv7()}`, // let OUR inbox do the dedup, not SQS
    }),
  );
  return messageId;
}

export async function drainQueue(
  queues: TestQueues,
  queueName: string,
  maxWaitMs = 5000,
): Promise<string[]> {
  const url = await resolveQueueUrl(queues.client, queueName);
  const bodies: string[] = [];
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const { Messages } = await queues.client.send(
      new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
    );
    if (!Messages || Messages.length === 0) {
      if (bodies.length > 0) break;
      continue;
    }
    for (const message of Messages) {
      bodies.push(message.Body ?? "");
      // Delete right away: an in-flight message would block the rest of its
      // FIFO group for the whole visibility timeout.
      await queues.client.send(
        new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle! }),
      );
    }
  }
  return bodies;
}

export async function purgeQueue(queues: TestQueues, queueName: string): Promise<void> {
  const url = await resolveQueueUrl(queues.client, queueName);
  await queues.client.send(new PurgeQueueCommand({ QueueUrl: url }));
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

/** Final invariant of every test: wallet.balance == balance rebuilt from the ledger. */
export async function expectWalletConsistent(ctx: TestContext, walletId: string): Promise<void> {
  const result = await ctx.reconcile.execute(walletId);
  expect(result.consistent).toBe(true);
  expect(result.difference.amount).toBe("0.00");
}

export function brl(amount: string) {
  return { amount, currency: "BRL" };
}
