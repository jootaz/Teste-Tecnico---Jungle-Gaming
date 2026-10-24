/**
 * Retries the given function on PostgreSQL transient concurrency errors
 * (serialization failure 40001, deadlock 40P01). Pessimistic wallet locking
 * makes these rare, but a bounded retry keeps workers resilient.
 */
const RETRYABLE_PG_CODES = new Set(["40001", "40P01"]);

export function isTransientPgError(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return typeof code === "string" && RETRYABLE_PG_CODES.has(code);
}

export async function withTransientRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientPgError(error) || attempt === maxAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
  throw lastError;
}
