// Dev launcher: starts the API from the repository root (used by .claude/launch.json).
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("./wagering-processor", import.meta.url)));
await import("./wagering-processor/src/main.ts");
