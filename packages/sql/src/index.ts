/**
 * Postgres on Bun, with types that hold for what the database returns.
 *
 * The migrations are SQL files and the source of truth: the types are
 * generated from the database they build, and the queries are Kysely's,
 * on Bun's own driver. Where no type can be inferred, the value is
 * checked: raw SQL by a schema, a broken constraint by its name.
 *
 * ```ts
 * import { SQL } from "bun";
 * import { migrate } from "@tetsujs/sql";
 *
 * const sql = new SQL(Bun.env.DATABASE_URL);
 * const { applied } = await migrate(sql, { dir: "./migrations" });
 * ```
 *
 * The package is being built, and is not published until every part of it
 * is in place.
 *
 * @module
 */

export type { MigrationErrorReason } from "./errors.ts";
export { MigrationError } from "./errors.ts";
export type {
  MigrateOptions,
  MigrateResult,
  MigrationRecord,
} from "./migrate.ts";
export { migrate } from "./migrate.ts";
