import { describe, expect, test } from "bun:test";
import { Money, InvalidMoneyError, CurrencyMismatchError } from "../../src/domain/value-objects/money";

describe("Money", () => {
  test("parses a valid decimal string and serializes with fixed scale 2", () => {
    expect(Money.from({ amount: "25.00", currency: "BRL" }).toJSON()).toEqual({
      amount: "25.00",
      currency: "BRL",
    });
    expect(Money.from({ amount: "25", currency: "BRL" }).toJSON().amount).toBe("25.00");
    expect(Money.from({ amount: "25.5", currency: "BRL" }).toJSON().amount).toBe("25.50");
  });

  test.each([
    [""],
    ["abc"],
    ["NaN"],
    ["Infinity"],
    ["-Infinity"],
    ["1e5"],
    ["2.5E2"],
    ["25.001"],
    ["-10.00"],
    ["10,00"],
    [" 10.00"],
    ["10.00 "],
    ["+10.00"],
    ["0x10"],
  ])("rejects invalid amount %p", (amount) => {
    expect(() => Money.from({ amount, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test.each([["brl"], ["B"], ["BRLL"], [""], ["123"]])("rejects invalid currency %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });

  test("arithmetic is exact where floats would fail", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754 — must be exact here.
    const a = Money.from({ amount: "0.10", currency: "BRL" });
    const b = Money.from({ amount: "0.20", currency: "BRL" });
    expect(a.add(b).toJSON().amount).toBe("0.30");

    let sum = Money.zero("BRL");
    for (let i = 0; i < 1000; i++) {
      sum = sum.add(Money.from({ amount: "0.01", currency: "BRL" }));
    }
    expect(sum.toJSON().amount).toBe("10.00");
  });

  test("operations are immutable", () => {
    const original = Money.from({ amount: "10.00", currency: "BRL" });
    const other = Money.from({ amount: "3.00", currency: "BRL" });
    original.add(other);
    original.subtract(other);
    original.negate();
    expect(original.toJSON().amount).toBe("10.00");
  });

  test("subtract can produce negative values internally", () => {
    const a = Money.from({ amount: "1.00", currency: "BRL" });
    const b = Money.from({ amount: "3.00", currency: "BRL" });
    const result = a.subtract(b);
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe("-2.00");
  });

  test("negate and abs", () => {
    const a = Money.from({ amount: "5.00", currency: "BRL" });
    expect(a.negate().isNegative()).toBe(true);
    expect(a.negate().abs().equals(a)).toBe(true);
  });

  test("cross-currency operations throw a domain error", () => {
    const brl = Money.from({ amount: "1.00", currency: "BRL" });
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl.equals(usd)).toBe(false);
  });

  test("comparisons", () => {
    const small = Money.from({ amount: "1.00", currency: "BRL" });
    const big = Money.from({ amount: "2.00", currency: "BRL" });
    expect(small.isLessThan(big)).toBe(true);
    expect(big.isLessThan(small)).toBe(false);
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(big.isPositive()).toBe(true);
  });
});
