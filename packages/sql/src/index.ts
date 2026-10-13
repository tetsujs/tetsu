/**
 * Postgres on Bun, with types that hold for what the database returns.
 *
 * The migrations are SQL files and the source of truth: the types are
 * generated from the database they build, and the queries are Kysely's,
 * on a driver of the package's own over Bun.SQL. A broken constraint is
 * told by the name the types hold, and a unit of work holds together
 * inside another's transaction.
 *
 * ```ts
 * import { database } from "@tetsujs/sql";
 * import { schema } from "./db.generated.ts";
 *
 * export const db = database(schema, { url: config.DATABASE_URL });
 *
 * const paid = await db
 *   .selectFrom("orders")
 *   .select(["id", "tags"])
 *   .where("status", "=", "paid")
 *   .execute();
 * ```
 *
 * `migrate()` applies the migrations, as a step of its own before the
 * application starts.
 *
 * The package is being built, and is not published until every part of it
 * is in place.
 *
 * @module
 */

export { atomic } from "./atomic.ts";
export type { DatabaseOptions } from "./database.ts";
export { database } from "./database.ts";
export type { MigrationErrorReason } from "./errors.ts";
export { MigrationError } from "./errors.ts";
export type {
  MigrateOptions,
  MigrateResult,
  MigrationRecord,
} from "./migrate.ts";
export { migrate } from "./migrate.ts";
export type { Schema } from "./schema.ts";
export { verifySchema } from "./verify.ts";
export type { ConstraintName, Constraints } from "./violation.ts";
export { isViolation } from "./violation.ts";
