/**
 * What development and CI need: new migration files, and — once the
 * generator is in place — the types of the database the migrations build.
 *
 * A scratch database is built from the migrations on a real server, its
 * catalog is read, and the result is written as a file of Kysely types —
 * the database the code is written against, as Postgres itself describes
 * it. In CI the same run checks that the file is up to date.
 *
 * ```ts
 * import { createMigration } from "@tetsujs/sql/generate";
 *
 * await createMigration({ dir: "./migrations", name: "add_orders" });
 * ```
 *
 * @module
 */

export type { CreateMigrationOptions } from "./migration-files.ts";
export { createMigration } from "./migration-files.ts";
