import { Type } from "class-transformer";
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from "class-validator";

export class MoneyDto {
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: "amount must be a non-negative decimal string with at most 2 decimal places",
  })
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: "currency must be an ISO-4217 code" })
  currency!: string;
}

export class CreateWalletDto {
  @IsUUID()
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

/** OPENING is internal and deliberately absent from the accepted kinds. */
export const SUBMITTABLE_KINDS = ["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"] as const;

export class SubmitTransactionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  providerId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  roundId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  gameId!: string;

  @IsIn(SUBMITTABLE_KINDS)
  kind!: (typeof SUBMITTABLE_KINDS)[number];

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  referenceExternalTransactionId?: string;
}

export class LedgerQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Matches(/^\d+$/)
  limit?: string;
}
