/**
 * The types of `database()`: the Kysely it returns is of the generated
 * `DB`, and its options are Bun's, but for those the package sets itself.
 *
 * @module
 */

import type { Kysely } from "kysely";
import type { DB } from "../test-utils/fixtures/schema/db.generated.ts";
import { schema } from "../test-utils/fixtures/schema/db.generated.ts";
import type { Equal, Expect } from "../test-utils/types.ts";
import type { DatabaseOptions } from "./database.ts";
import { database } from "./database.ts";
import type { Schema } from "./schema.ts";

declare const url: string;

const db = database(schema, { url });

export type built = [Expect<Equal<typeof db, Kysely<DB>>>];

export const pooled: DatabaseOptions = {
  url,
  max: 20,
  idleTimeout: 30,
  prepare: false,
  tls: true,
  password: async () => "rotated",
  connection: { application_name: "billing" },
};

export const forced: DatabaseOptions = {
  url,
  // @ts-expect-error the package reads int8 as bigint, as the types say
  bigint: false,
};

export const adapted: DatabaseOptions = {
  url,
  // @ts-expect-error the package runs on Postgres only
  adapter: "mysql",
};

// @ts-expect-error the URL is the whole address: the environment is not read
export const unaddressed: DatabaseOptions = { max: 1 };

export const described: Schema<DB> = {
  journal: "migrations",
  migration: null,
  arrays: { orders: { tags: "," } },
};

// @ts-expect-error a schema names its columns of arrays
export const undescribed: Schema<DB> = {
  journal: "migrations",
  migration: null,
};
