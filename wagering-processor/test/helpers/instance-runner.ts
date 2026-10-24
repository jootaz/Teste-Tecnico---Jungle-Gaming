/**
 * Standalone process used by the multi-instance concurrency test.
 * Each spawned instance opens its own ORM/connection pool against the shared
 * database and submits wagers concurrently, printing one JSON line per result.
 *
 * Env:
 *   DATABASE_URL   shared test database
 *   WALLET_ID      target wallet
 *   PLAYER_ID      wallet owner
 *   MODE           "same-bet" (everyone sends the same idempotency key)
 *                  or "distinct" (each attempt is a new bet)
 *   ATTEMPTS       submissions per instance
 *   SHARED_EXTERNAL_ID  external id used by every instance in same-bet mode
 *   AMOUNT         bet amount (default 10.00)
 */
import { MikroORM } from "@mikro-orm/postgresql";
import { v7 as uuidv7 } from "uuid";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/unit-of-work";
import { SubmitWagerTransactionUseCase } from "../../src/application/use-cases/submit-wager-transaction";
import { WagerTransactionKind } from "../../src/domain/entities/wager-transaction";

const walletId = process.env.WALLET_ID!;
const playerId = process.env.PLAYER_ID!;
const mode = process.env.MODE ?? "distinct";
const attempts = Number(process.env.ATTEMPTS ?? "10");
const sharedExternalId = process.env.SHARED_EXTERNAL_ID ?? "shared";
const amount = process.env.AMOUNT ?? "10.00";

const orm = await MikroORM.init(buildOrmConfig(process.env.DATABASE_URL));
const useCase = new SubmitWagerTransactionUseCase(new MikroOrmUnitOfWork(orm));

const results = await Promise.all(
  Array.from({ length: attempts }, async () => {
    const externalId = mode === "same-bet" ? sharedExternalId : uuidv7();
    try {
      const result = await useCase.execute(
        {
          providerId: "provider-a",
          externalTransactionId: externalId,
          idempotencyKey: `provider-a:${externalId}`,
          playerId,
          walletId,
          roundId: "round-multi",
          gameId: "game-multi",
          kind: WagerTransactionKind.Bet,
          money: { amount, currency: "BRL" },
        },
        { correlationId: externalId },
      );
      return { status: result.status, idempotentReplay: result.idempotentReplay };
    } catch (error) {
      return { status: "ERROR", error: String(error) };
    }
  }),
);

for (const result of results) {
  console.log(`RESULT ${JSON.stringify(result)}`);
}

await orm.close(true);
