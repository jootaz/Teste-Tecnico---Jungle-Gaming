import { createHash } from "node:crypto";

/**
 * Business fields that participate in the idempotency payload hash.
 * Transport metadata (headers, messageId, occurredAt) is deliberately excluded.
 */
export interface WagerPayloadForHash {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/** Recursively sorts object keys so the serialization is canonical. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) {
        sorted[key] = canonicalize(v);
      }
    }
    return sorted;
  }
  return value;
}

/**
 * SHA-256 hex digest of the canonical JSON (recursively sorted keys,
 * undefined fields omitted) of the business payload.
 */
export function computePayloadHash(payload: WagerPayloadForHash): string {
  const canonical = JSON.stringify(canonicalize(payload));
  return createHash("sha256").update(canonical).digest("hex");
}
