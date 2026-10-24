import type { MoneyProps } from "../../domain/value-objects/money";
import type { UnitOfWork } from "../ports";
import { WalletNotFoundError } from "../errors";
import { NoopMetrics, type MetricsPort } from "../metrics-port";

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compares the materialized balance against the balance reconstructed from
 * the ledger (credits - debits). Divergences are never silently fixed:
 * they are reported, logged and counted by the caller through MetricsPort.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    const result = await this.uow.run(async (repos) => {
      // Lock the wallet so the snapshot is consistent with the ledger scan.
      const wallet = await repos.wallets.findByIdForUpdate(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);

      const aggregate = await repos.ledger.aggregateByWallet(walletId, wallet.currency);
      const calculated = aggregate.credits.subtract(aggregate.debits);
      const difference = wallet.balance.subtract(calculated);

      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: aggregate.count,
      };
    });

    if (!result.consistent) {
      this.metrics.reconciliationDivergence();
    }
    return result;
  }
}
