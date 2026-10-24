import { Money } from "../value-objects/money";
import { BusinessRuleViolationError, DomainValidationError } from "../errors";
import { FailureCode } from "../failure-codes";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BalanceMovement {
  balanceBefore: Money;
  balanceAfter: Money;
}

/**
 * Aggregate root for a player's funds in a single currency.
 *
 * Every balance mutation goes through debit/credit, bumps `version`
 * and reports the before/after pair so the caller can write the
 * corresponding (mandatory) ledger entry in the same SQL transaction.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new DomainValidationError("initial balance cannot be negative");
    }
    const now = new Date();
    // Version starts at 1 on creation; the OPENING credit (when > 0) is applied
    // by the use case through credit(), which bumps it — so a wallet opened with
    // funds still has version 1 because open() starts at 0 and the credit bumps to 1,
    // while a zero-balance wallet is persisted with version 1 directly.
    const startsWithFunds = props.initialBalance.isPositive();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      Money.zero(props.initialBalance.currency),
      startsWithFunds ? 0 : 1,
      now,
      now,
    );
  }

  /** Rebuilds persisted state — performs no transition validation. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(money: Money, at: Date = new Date()): BalanceMovement {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new DomainValidationError("debit amount must be positive");
    }
    if (this._balance.isLessThan(money)) {
      throw new BusinessRuleViolationError(
        FailureCode.InsufficientFunds,
        `insufficient funds: balance ${this._balance.toString()} < debit ${money.toString()}`,
      );
    }
    const balanceBefore = this._balance;
    this._balance = this._balance.subtract(money);
    this._version += 1;
    this._updatedAt = at;
    return { balanceBefore, balanceAfter: this._balance };
  }

  credit(money: Money, at: Date = new Date()): BalanceMovement {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new DomainValidationError("credit amount must be positive");
    }
    const balanceBefore = this._balance;
    this._balance = this._balance.add(money);
    this._version += 1;
    this._updatedAt = at;
    return { balanceBefore, balanceAfter: this._balance };
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new BusinessRuleViolationError(
        FailureCode.CurrencyMismatch,
        `operation currency ${money.currency} does not match wallet currency ${this.currency}`,
      );
    }
  }
}
