import { describe, expect, test } from "bun:test";
import { Wallet } from "../../src/domain/entities/wallet";
import { Money } from "../../src/domain/value-objects/money";
import { BusinessRuleViolationError, DomainValidationError } from "../../src/domain/errors";
import { FailureCode } from "../../src/domain/failure-codes";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

function fundedWallet(amount = "100.00"): Wallet {
  const wallet = Wallet.open({ id: "w-1", playerId: "p-1", initialBalance: brl(amount) });
  wallet.credit(brl(amount));
  return wallet;
}

describe("Wallet", () => {
  test("open + opening credit leaves version 1 and the initial balance", () => {
    const wallet = fundedWallet("1000.00");
    expect(wallet.balance.toJSON().amount).toBe("1000.00");
    expect(wallet.version).toBe(1);
  });

  test("zero-balance wallet starts at version 1 without any credit", () => {
    const wallet = Wallet.open({ id: "w-2", playerId: "p-1", initialBalance: brl("0.00") });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("debit reduces balance, bumps version and reports before/after", () => {
    const wallet = fundedWallet("100.00");
    const movement = wallet.debit(brl("25.00"));
    expect(movement.balanceBefore.toJSON().amount).toBe("100.00");
    expect(movement.balanceAfter.toJSON().amount).toBe("75.00");
    expect(wallet.balance.toJSON().amount).toBe("75.00");
    expect(wallet.version).toBe(2);
  });

  test("debit beyond balance throws INSUFFICIENT_FUNDS and mutates nothing", () => {
    const wallet = fundedWallet("10.00");
    try {
      wallet.debit(brl("10.01"));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessRuleViolationError);
      expect((error as BusinessRuleViolationError).failureCode).toBe(FailureCode.InsufficientFunds);
    }
    expect(wallet.balance.toJSON().amount).toBe("10.00");
    expect(wallet.version).toBe(1);
  });

  test("debit of the exact balance is allowed (balance reaches zero)", () => {
    const wallet = fundedWallet("10.00");
    wallet.debit(brl("10.00"));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("credit/debit with a different currency throws CURRENCY_MISMATCH", () => {
    const wallet = fundedWallet("10.00");
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    for (const op of [() => wallet.credit(usd), () => wallet.debit(usd)]) {
      try {
        op();
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(BusinessRuleViolationError);
        expect((error as BusinessRuleViolationError).failureCode).toBe(FailureCode.CurrencyMismatch);
      }
    }
  });

  test("zero or negative movements are rejected", () => {
    const wallet = fundedWallet("10.00");
    expect(() => wallet.credit(brl("0.00"))).toThrow(DomainValidationError);
    expect(() => wallet.debit(brl("0.00"))).toThrow(DomainValidationError);
  });

  test("version increments only when the balance changes", () => {
    const wallet = fundedWallet("10.00");
    const versionBefore = wallet.version;
    try {
      wallet.debit(brl("99.00"));
    } catch {
      // rejected — no state change
    }
    expect(wallet.version).toBe(versionBefore);
    wallet.credit(brl("1.00"));
    expect(wallet.version).toBe(versionBefore + 1);
  });
});
