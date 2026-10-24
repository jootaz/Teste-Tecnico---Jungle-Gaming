import { v7 as uuidv7 } from "uuid";
import { Money, type MoneyProps } from "../../domain/value-objects/money";
import { Wallet } from "../../domain/entities/wallet";
import { WagerTransaction } from "../../domain/entities/wager-transaction";
import { WalletLedgerEntry, LedgerDirection } from "../../domain/entities/wallet-ledger-entry";
import { OutboxMessage } from "../../domain/entities/outbox-message";
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "../../domain/events/wagering-events";
import type { EventContext } from "../../domain/events/integration-event";
import { UniqueConstraintViolation, type UnitOfWork } from "../ports";
import { WalletAlreadyExistsError } from "../errors";
import { computePayloadHash } from "../../domain/services/payload-hash";

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
}

const INTERNAL_PROVIDER = "internal";

/**
 * Opens a wallet. A positive initial balance produces an internal OPENING
 * transaction with its CREDIT ledger entry in the same SQL transaction.
 */
export class CreateWalletUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(command: CreateWalletCommand, ctx: EventContext): Promise<CreateWalletResult> {
    const initialBalance = Money.from(command.initialBalance);
    const walletId = uuidv7();

    try {
      return await this.uow.run(async (repos) => {
        const wallet = Wallet.open({ id: walletId, playerId: command.playerId, initialBalance });
        await repos.wallets.insert(wallet);

        if (initialBalance.isPositive()) {
          const externalTransactionId = `opening:${wallet.id}`;
          const opening = WagerTransaction.createOpening({
            id: uuidv7(),
            providerId: INTERNAL_PROVIDER,
            externalTransactionId,
            idempotencyKey: `${INTERNAL_PROVIDER}:${externalTransactionId}`,
            payloadHash: computePayloadHash({
              providerId: INTERNAL_PROVIDER,
              externalTransactionId,
              playerId: wallet.playerId,
              walletId: wallet.id,
              roundId: externalTransactionId,
              gameId: INTERNAL_PROVIDER,
              kind: "OPENING",
              money: initialBalance.toJSON(),
            }),
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: externalTransactionId,
            gameId: INTERNAL_PROVIDER,
            money: initialBalance,
          });
          await repos.transactions.insert(opening);

          const now = new Date();
          const movement = wallet.credit(initialBalance, now);
          const entry = WalletLedgerEntry.create({
            id: uuidv7(),
            walletId: wallet.id,
            transactionId: opening.id,
            direction: LedgerDirection.Credit,
            money: initialBalance,
            balanceBefore: movement.balanceBefore,
            balanceAfter: movement.balanceAfter,
            createdAt: now,
          });
          opening.markProcessed(undefined, now, wallet.balance);

          await repos.wallets.update(wallet);
          await repos.ledger.insert(entry);
          await repos.transactions.update(opening);
          await repos.outbox.insert([
            OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx)),
            OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx)),
          ]);
        }

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
          createdAt: wallet.createdAt.toISOString(),
        };
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolation) {
        throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);
      }
      throw error;
    }
  }
}
