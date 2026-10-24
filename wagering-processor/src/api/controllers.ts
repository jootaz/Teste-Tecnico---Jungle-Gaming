import {
  BadRequestException
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { Response, Request } from "express";
import { Req } from "@nestjs/common";
import { v7 as uuidv7 } from "uuid";
import type { CreateWalletUseCase } from "../application/use-cases/create-wallet";
import type {
  SubmitWagerTransactionUseCase,
  SubmitResult,
} from "../application/use-cases/submit-wager-transaction";
import type { ReconcileWalletUseCase } from "../application/use-cases/reconcile-wallet";
import type { TransactionQueries, WalletQueries } from "../application/use-cases/queries";
import { WagerTransactionStatus, WagerTransactionKind } from "../domain/entities/wager-transaction";
import { CreateWalletDto, LedgerQueryDto, SubmitTransactionDto } from "./dtos";
import { TOKENS } from "./tokens";

function correlationIdFrom(req: Request): string {
  const header = req.headers["x-correlation-id"];
  return typeof header === "string" && header.length > 0 ? header : uuidv7();
}

function statusCodeFor(result: SubmitResult): number {
  switch (result.status) {
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED; // 202
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY; // 422
    case WagerTransactionStatus.Failed:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    default:
      // PROCESSED: 201 on first processing, 200 on idempotent replay.
      return result.idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED;
  }
}

@Controller()
export class WalletsController {
  constructor(
    @Inject(TOKENS.CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(TOKENS.WalletQueries) private readonly walletQueries: WalletQueries,
    @Inject(TOKENS.ReconcileWalletUseCase) private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post("/wallets")
  async create(@Body() dto: CreateWalletDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    const result = await this.createWallet.execute(
      { playerId: dto.playerId, initialBalance: dto.initialBalance },
      { correlationId: correlationIdFrom(req) },
    );
    res.status(HttpStatus.CREATED).json({
      id: result.id,
      playerId: result.playerId,
      balance: result.balance,
      version: result.version,
    });
  }

  @Get("/wallets/:walletId")
  async get(@Param("walletId", ParseUUIDPipe) walletId: string) {
    return this.walletQueries.getWallet(walletId);
  }

  @Get("/wallets/:walletId/ledger")
  async ledger(@Param("walletId", ParseUUIDPipe) walletId: string, @Query() query: LedgerQueryDto) {
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
    return this.walletQueries.getLedger(walletId, query.cursor, limit);
  }

  @Post("/wallets/:walletId/reconciliation")
  async reconciliation(@Param("walletId", ParseUUIDPipe) walletId: string) {
    return this.reconcile.execute(walletId);
  }
}

@Controller()
export class WageringController {
  constructor(
    @Inject(TOKENS.SubmitUseCase) private readonly submit: SubmitWagerTransactionUseCase,
    @Inject(TOKENS.TransactionQueries) private readonly transactionQueries: TransactionQueries,
  ) {}

  @Post("/wagering/transactions")
  async submitTransaction(
    @Body() dto: SubmitTransactionDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new BadRequestException("Idempotency-Key header is required");
    }
    const correlationId = correlationIdFrom(req);
    const result = await this.submit.execute(
      {
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        idempotencyKey: idempotencyKey.trim(),
        playerId: dto.playerId,
        walletId: dto.walletId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: dto.kind as WagerTransactionKind,
        money: dto.money,
        referenceExternalTransactionId: dto.referenceExternalTransactionId,
      },
      { correlationId },
    );

    res.status(statusCodeFor(result)).json({
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      failureCode: result.failureCode,
      idempotentReplay: result.idempotentReplay,
    });
  }

  @Get("/wagering/transactions/:transactionId")
  async getById(@Param("transactionId", ParseUUIDPipe) transactionId: string) {
    return this.transactionQueries.getById(transactionId);
  }
}

@Controller()
export class ProvidersController {
  constructor(
    @Inject(TOKENS.TransactionQueries) private readonly transactionQueries: TransactionQueries,
  ) {}

  @Get("/providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByProvider(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return this.transactionQueries.getByProviderAndExternalId(providerId, externalTransactionId);
  }
}
