/**
 * Postgres on Bun, with types that hold for what the database returns.
 *
 * The migrations are SQL files and the source of truth: the types are
 * generated from the database they build, and the queries are Kysely's,
 * on Bun's own driver. Where no type can be inferred, the value is
 * checked: raw SQL by a schema, a broken constraint by its name.
 *
 * The package is being built: nothing is exported yet, and it is not
 * published until every part of it is in place.
 *
 * @module
 */
