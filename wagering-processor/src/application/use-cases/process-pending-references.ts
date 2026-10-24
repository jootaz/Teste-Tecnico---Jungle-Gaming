import type { UnitOfWork } from "../ports";
import { withTransientRetry } from "../retry";
import type { SubmitWagerTransactionUseCase } from "./submit-wager-transaction";

/**
 * Scheduled reprocessing of PENDING_REFERENCE transactions.
 *
 * Due rows are claimed with FOR UPDATE SKIP LOCKED so concurrent workers on
 * different instances never grab the same transaction. Each claimed row is
 * re-applied through the same use case as HTTP/SQS; when the retry budget is
 * exhausted it is REJECTED with REFERENCE_NOT_FOUND and the corresponding
 * event is published through the outbox.
 */
export class ProcessPendingReferencesUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly submitUseCase: SubmitWagerTransactionUseCase,
  ) {}

  /** Returns the number of transactions touched (processed, re-scheduled or rejected). */
  async executeBatch(batchSize = 10): Promise<number> {
    return withTransientRetry(() =>
      this.uow.run(async (repos) => {
        const due = await repos.transactions.findDuePendingReferenceForUpdate(new Date(), batchSize);
        for (const transaction of due) {
          await this.submitUseCase.applyToWallet(repos, transaction, {
            // Worker-driven continuation: correlate by the transaction itself.
            correlationId: transaction.id,
          });
        }
        return due.length;
      }),
    );
  }
}
