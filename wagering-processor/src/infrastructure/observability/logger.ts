import pino, { type Logger } from "pino";

/**
 * Structured JSON logger. Correlation fields (correlationId, messageId,
 * transactionId, walletId, providerId) travel as bound child-logger fields.
 * Financial payloads are never logged whole — only identifiers and amounts
 * where strictly needed for diagnosis.
 */
export function createLogger(): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { service: "wagering-processor", instance: process.env.INSTANCE_ID ?? "local" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

export type { Logger };
