import { Decimal } from "decimal.js";

export interface MoneyProps {
  amount: string; // decimal string, e.g. "25.00"
  currency: string; // ISO-4217
}

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SCALE = 2;

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Currency mismatch: ${a} != ${b}`);
    this.name = "CurrencyMismatchError";
  }
}

export class InvalidMoneyError extends Error {
  constructor(reason: string) {
    super(`Invalid money: ${reason}`);
    this.name = "InvalidMoneyError";
  }
}

/**
 * Immutable monetary value with a fixed scale of 2.
 * Arithmetic never mutates; every operation returns a new instance.
 * Negative values can only arise from arithmetic (subtract/negate),
 * never from external input (`from` rejects them).
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (typeof props?.amount !== "string" || props.amount.length === 0) {
      throw new InvalidMoneyError("amount must be a non-empty decimal string");
    }
    if (!AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(
        `amount "${props.amount}" must be a non-negative decimal string with at most ${SCALE} decimal places`,
      );
    }
    if (typeof props.currency !== "string" || !CURRENCY_PATTERN.test(props.currency)) {
      throw new InvalidMoneyError(`currency "${props.currency}" must be an ISO-4217 code`);
    }
    const value = new Decimal(props.amount);
    if (!value.isFinite()) {
      throw new InvalidMoneyError("amount must be finite");
    }
    return new Money(value.toDecimalPlaces(SCALE), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  abs(): Money {
    return new Money(this.value.abs(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  hasSameCurrency(other: Money): boolean {
    return this.currency === other.currency;
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(SCALE), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(SCALE)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
