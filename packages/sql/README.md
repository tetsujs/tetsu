# @tetsujs/sql

Postgres for [Tetsu](https://tetsujs.com), on Bun's own client: SQL migrations as the schema, Kysely types generated from the database they build, and SQL files typed by Postgres itself.

```bash
bun add @tetsujs/sql kysely
```

```ts
import { database } from "@tetsujs/sql";
import { config } from "./config";
import { schema } from "./db.generated";

export const db = database(schema, { url: config.DATABASE_URL });

const paid = await db
  .selectFrom("orders")
  .select(["id", "total", "placed_at"])
  .where("status", "=", "paid")
  .execute();
```

`tetsu-sql migrations:run` applies the migrations, and `tetsu-sql types:generate` writes `db.generated.ts` from the database they build. It needs Bun 1.4.4 or later and Postgres 14 or later.

## Documentation

- [tetsujs.com/docs/database](https://tetsujs.com/docs/database/): migrations, types, queries,
  query files, transactions, testing, deploy and Bun's limits, also
  [as Markdown](https://tetsujs.com/docs/database.md)
- [llms-full.txt](https://tetsujs.com/llms-full.txt): the whole documentation in one
  file, for tools and AI assistants
- every export and option is also documented in the package's type
  definitions, which editors and tools read from `node_modules`

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
