/**
 * Migration runner: `bun run migration:up` / `bun run migration:down`.
 */
import { initOrm } from "./orm";

const direction = process.argv[2] ?? "up";

const orm = await initOrm();
const migrator = orm.getMigrator();

try {
  if (direction === "down") {
    const result = await migrator.down();
    console.log(`reverted ${result.length} migration(s)`);
  } else {
    const result = await migrator.up();
    console.log(`applied ${result.length} migration(s)`);
  }
} finally {
  await orm.close(true);
}
