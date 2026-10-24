import type { MikroORM } from "@mikro-orm/postgresql";
import type { SqlEntityManager } from "@mikro-orm/postgresql";
import type { TransactionalRepositories, UnitOfWork } from "../../application/ports";
import {
  MikroOrmInboxRepository,
  MikroOrmLedgerRepository,
  MikroOrmOutboxRepository,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from "./repositories";

export function createRepositories(em: SqlEntityManager): TransactionalRepositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}

/**
 * MikroORM-backed unit of work: `run` executes the callback inside
 * `EntityManager.transactional()` on a forked EM, so inbox row, wallet
 * update, ledger entry and outbox events commit or roll back together.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(fn: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    const em = this.orm.em.fork() as SqlEntityManager;
    return em.transactional(async (tem) => fn(createRepositories(tem as SqlEntityManager)));
  }
}
