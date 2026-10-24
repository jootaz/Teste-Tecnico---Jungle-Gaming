import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MikroORM, defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { ALL_SCHEMAS } from "./records";

const MIGRATIONS_PATH = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export function buildOrmConfig(clientUrl?: string) {
  return defineConfig({
    clientUrl: clientUrl ?? process.env.DATABASE_URL ?? "postgresql://wagering:wagering@localhost:5432/wagering",
    entities: ALL_SCHEMAS,
    extensions: [Migrator],
    migrations: {
      path: MIGRATIONS_PATH,
      pathTs: MIGRATIONS_PATH,
      glob: "!(*.d).{js,ts}",
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    pool: { min: 1, max: 10 },
    // Workers and request handlers always fork their own EM.
    allowGlobalContext: false,
    debug: false,
  });
}

export async function initOrm(clientUrl?: string): Promise<MikroORM> {
  return MikroORM.init(buildOrmConfig(clientUrl));
}
