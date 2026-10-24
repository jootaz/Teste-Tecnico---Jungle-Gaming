import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Response } from "express";
import {
  IdempotencyConflictError,
  TransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../application/errors";
import { DomainValidationError } from "../domain/errors";
import { InvalidMoneyError, CurrencyMismatchError } from "../domain/value-objects/money";
import { FailureCode } from "../domain/failure-codes";
import type { Logger } from "../infrastructure/observability/logger";

/**
 * HTTP status mapping (consistent across every endpoint):
 *
 *   400 — invalid payload (shape/contract)             VALIDATION_FAILED
 *   404 — wallet/transaction not found
 *   409 — idempotency payload conflict / duplicate wallet
 *   422 — business-rule rejection (REJECTED, auditable)
 *   202 — accepted, waiting for reference (PENDING_REFERENCE)
 *   503 — transient infrastructure failure (safe to retry)
 *
 * Providers can rely on the status code alone to decide between resending,
 * fixing the payload or giving up — no error-message parsing required.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response.status(status).json(
        typeof body === "string"
          ? { error: FailureCode.ValidationFailed, message: body }
          : { error: FailureCode.ValidationFailed, ...(body as object) },
      );
      return;
    }

    if (
      exception instanceof InvalidMoneyError ||
      exception instanceof CurrencyMismatchError ||
      exception instanceof DomainValidationError
    ) {
      response.status(HttpStatus.BAD_REQUEST).json({
        error: FailureCode.ValidationFailed,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof IdempotencyConflictError) {
      response.status(HttpStatus.CONFLICT).json({
        error: exception.failureCode,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof WalletAlreadyExistsError) {
      response.status(HttpStatus.CONFLICT).json({
        error: "WALLET_ALREADY_EXISTS",
        message: exception.message,
      });
      return;
    }

    if (exception instanceof WalletNotFoundError || exception instanceof TransactionNotFoundError) {
      response.status(HttpStatus.NOT_FOUND).json({
        error: "NOT_FOUND",
        message: exception.message,
      });
      return;
    }

    // Anything else is treated as a transient infrastructure failure:
    // the provider may safely retry with the same Idempotency-Key.
    this.logger.error({ err: String(exception) }, "unhandled error");
    response
      .status(HttpStatus.SERVICE_UNAVAILABLE)
      .header("Retry-After", "1")
      .json({ error: "TRANSIENT_FAILURE", message: "temporary failure, retry with the same Idempotency-Key" });
  }
}
