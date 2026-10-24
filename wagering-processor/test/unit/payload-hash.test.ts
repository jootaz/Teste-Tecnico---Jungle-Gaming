import { describe, expect, test } from "bun:test";
import { computePayloadHash } from "../../src/domain/services/payload-hash";

const base = {
  providerId: "provider-a",
  externalTransactionId: "tx-1",
  playerId: "p-1",
  walletId: "w-1",
  roundId: "r-1",
  gameId: "g-1",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("computePayloadHash", () => {
  test("is stable regardless of key order", () => {
    const shuffled = {
      money: { currency: "BRL", amount: "25.00" },
      kind: "BET",
      gameId: "g-1",
      roundId: "r-1",
      walletId: "w-1",
      playerId: "p-1",
      externalTransactionId: "tx-1",
      providerId: "provider-a",
    };
    expect(computePayloadHash(base)).toBe(computePayloadHash(shuffled as typeof base));
  });

  test("changes when any business field changes", () => {
    const original = computePayloadHash(base);
    expect(computePayloadHash({ ...base, money: { amount: "25.01", currency: "BRL" } })).not.toBe(original);
    expect(computePayloadHash({ ...base, roundId: "r-2" })).not.toBe(original);
    expect(computePayloadHash({ ...base, referenceExternalTransactionId: "x" })).not.toBe(original);
  });

  test("omitted and undefined optional fields hash identically", () => {
    expect(computePayloadHash({ ...base, referenceExternalTransactionId: undefined })).toBe(
      computePayloadHash(base),
    );
  });
});
