/**
 * A database of its own for each test file, built from the migrations.
 *
 * Tests of code that talks to Postgres run against a real server: a mock
 * of the driver passes queries the database would refuse. Each test file
 * gets an empty database with the migrations applied, dropped when the
 * file ends, so files neither see nor clean up each other's rows.
 *
 * The package is being built: nothing is exported yet.
 *
 * @module
 */
