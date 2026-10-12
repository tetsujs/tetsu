/**
 * The types of a database, generated from its migrations.
 *
 * A scratch database is built from the migrations on a real server, its
 * catalog is read, and the result is written as a file of Kysely types —
 * the database the code is written against, as Postgres itself describes
 * it. In CI the same run checks that the file is up to date.
 *
 * The package is being built: nothing is exported yet.
 *
 * @module
 */
