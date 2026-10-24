import type { MoneyProps } from "../../domain/value-objects/money";
import type { FailureCode } from "../../domain/failure-codes";
import type { UnitOfWork } from "../ports";
import { TransactionNotFoundError, WalletNotFoundError } from "../errors";

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode?: FailureCode;
  referenceTransactionId?: string;
  referenceExternalTransactionId?: string;
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  entries: LedgerEntryView[];
  nextCursor?: string;
}

export class WalletQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getWallet(walletId: string): Promise<WalletView> {
    return this.uow.run(async (repos) => {
      const wallet = await repos.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
        createdAt: wallet.createdAt.toISOString(),
        updatedAt: wallet.updatedAt.toISOString(),
      };
    });
  }

  async getLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageView> {
    return this.uow.run(async (repos) => {
      const wallet = await repos.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      const page = await repos.ledger.findByWallet(walletId, cursor, limit);
      return {
        entries: page.entries.map((entry) => ({
          id: entry.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          createdAt: entry.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    });
  }
}

export class TransactionQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getById(transactionId: string): Promise<TransactionView> {
    return this.uow.run(async (repos) => {
      const transaction = await repos.transactions.findById(transactionId);
      if (!transaction) throw new TransactionNotFoundError(transactionId);
      return this.toView(transaction);
    });
  }

  async getByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    return this.uow.run(async (repos) => {
      const transaction = await repos.transactions.findByProviderAndExternalId(
        providerId,
        externalTransactionId,
      );
      if (!transaction) {
        throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
      }
      return this.toView(transaction);
    });
  }

  private toView(transaction: import("../../domain/entities/wager-transaction").WagerTransaction): TransactionView {
    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      status: transaction.status,
      failureCode: transaction.failureCode,
      referenceTransactionId: transaction.referenceTransactionId,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      balance: transaction.observedBalance?.toJSON(),
      createdAt: transaction.createdAt.toISOString(),
      processedAt: transaction.processedAt?.toISOString(),
    };
  }
}
