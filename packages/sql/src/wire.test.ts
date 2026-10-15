/**
 * The client of Postgres's protocol: the settings it takes from Bun, its
 * sessions with a real Postgres — the statements it is described, the
 * plain queries it runs — and, against a stub server, how it starts a
 * session: TLS, each way to authenticate, and a server that misbehaves.
 *
 * @module
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { SQL } from "bun";
import { DATABASE_MS, testDatabase } from "../test-utils/database.ts";
import type { Peer } from "../test-utils/stub-server.ts";
import {
  authentication,
  authority,
  backend,
  cstring,
  errorResponse,
  int16,
  int32,
  READY,
  startupOf,
  stubServer,
} from "../test-utils/stub-server.ts";
import { clientOf } from "./client.ts";
import { settingsOf, socketOf, tlsOptionsOf, Wire } from "./wire.ts";

setDefaultTimeout(DATABASE_MS);

const { sql, url, name } = testDatabase();

/** The request for TLS, as the body of a message without a type. */
const SSL_REQUEST = int32(80_877_103);

/** The settings Bun resolves for a client of the URL `of`. */
function settings(of: string) {
  return settingsOf(new SQL(of));
}

/**
 * Closes a Bun client a stub server cut, waiting a second at most: Bun's
 * `close()` of such a client now and then never settles.
 */
async function closeCut(client: SQL): Promise<void> {
  await Promise.race([client.close({ timeout: 0 }), Bun.sleep(1000)]);
}

/** The server's side of a session that needs no password, up to its being ready. */
async function trust(peer: Peer): Promise<void> {
  await peer.untyped();
  peer.send(authentication(0), READY);
}

/**
 * The server's side of SCRAM-SHA-256, as RFC 5802 lays it out, for the
 * password `secret`, up to the client's proof: what the client sent,
 * whether the proof holds, and the signature that proves the server knows
 * the password.
 */
async function scram(
  peer: Peer,
  offered: readonly string[] = ["SCRAM-SHA-256-PLUS", "SCRAM-SHA-256"],
): Promise<{
  readonly mechanism: string;
  readonly first: string;
  readonly proved: boolean;
  readonly signature: string;
}> {
  peer.send(authentication(10, ...offered.map(cstring), Buffer.from([0])));

  const initial = (await peer.message()).body;
  const end = initial.indexOf(0);
  const mechanism = initial.toString("utf8", 0, end);
  const first = initial.subarray(end + 5).toString();
  const bare = first.slice(3);
  const nonce = `${/r=([^,]+)/.exec(bare)?.[1]}server`;
  const salt = randomBytes(16);
  const serverFirst = `r=${nonce},s=${salt.toString("base64")},i=4096`;

  peer.send(authentication(11, Buffer.from(serverFirst)));

  const final = (await peer.message()).body.toString();
  const withoutProof = final.slice(0, final.lastIndexOf(",p="));
  const proof = Buffer.from(
    final.slice(final.lastIndexOf(",p=") + 3),
    "base64",
  );
  const salted = pbkdf2Sync("secret", salt, 4096, 32, "sha256");
  const hmac = (key: Buffer, text: string) =>
    createHmac("sha256", key).update(text).digest();
  const storedKey = createHash("sha256")
    .update(hmac(salted, "Client Key"))
    .digest();
  const message = `${bare},${serverFirst},${withoutProof}`;
  const clientSignature = hmac(storedKey, message);
  const clientKey = proof.map(
    (byte, index) => byte ^ (clientSignature[index] as number),
  );

  return {
    mechanism,
    first,
    proved:
      withoutProof === `c=biws,r=${nonce}` &&
      createHash("sha256").update(clientKey).digest().equals(storedKey),
    signature: hmac(hmac(salted, "Server Key"), message).toString("base64"),
  };
}

/**
 * The server's side of a plain query: it answers with `rows` of one
 * column, and resolves to the query's text.
 */
async function answer(peer: Peer, rows: readonly string[]): Promise<string> {
  const { type, body } = await peer.message();

  expect(type).toBe("Q");
  peer.send(
    backend(
      "T",
      int16(1),
      cstring("a"),
      int32(0),
      int16(0),
      int32(25),
      int16(-1),
      int32(-1),
      int16(0),
    ),
    ...rows.map((value) =>
      backend(
        "D",
        int16(1),
        int32(Buffer.byteLength(value)),
        Buffer.from(value),
      ),
    ),
    backend("C", cstring(`SELECT ${rows.length}`)),
    READY,
  );

  return body.toString("utf8", 0, body.length - 1);
}

describe("the settings of a connection", () => {
  test("are those Bun resolved from the URL", () => {
    expect(
      settings(
        "postgres://user:p%40ss@db.example:6543/app?sslmode=verify-full&options=-c%20search_path%3Dapp&application_name=x",
      ),
    ).toEqual({
      host: "db.example",
      port: 6543,
      user: "user",
      password: "p@ss",
      database: "app",
      sslmode: "verify-full",
      servername: "db.example",
      parameters: [
        ["options", "-c search_path=app"],
        ["application_name", "x"],
      ],
      timeout: 30_000,
    });
  });

  test("take what the URL leaves out from the environment, as Bun does", () => {
    const names = ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGSSLMODE"];
    const before = names.map((key) => process.env[key]);

    Object.assign(process.env, {
      PGHOST: "env.example",
      PGPORT: "6001",
      PGUSER: "envuser",
      PGPASSWORD: "envpass",
      PGSSLMODE: "require",
    });

    try {
      expect(settings("postgres://")).toMatchObject({
        host: "env.example",
        port: 6001,
        user: "envuser",
        password: "envpass",
        database: "envuser",
        sslmode: "require",
      });
      expect(settings("postgres://u:p@h:1/db?sslmode=disable")).toMatchObject({
        host: "h",
        port: 1,
        user: "u",
        password: "p",
        database: "db",
        sslmode: "disable",
      });
    } finally {
      names.forEach((key, index) => {
        const value = before[index];

        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      });
    }
  });

  test("have the database the package's own clients reach", () => {
    expect(settingsOf(clientOf("postgres://u@h/")).database).toBe("u");
    expect(settingsOf(clientOf("postgres://u@h/other")).database).toBe("other");
  });

  test("of IPv6 have the address without its brackets", () => {
    expect(
      settings("postgres://u@[::1]:5440/app?sslmode=require"),
    ).toMatchObject({ host: "::1", servername: "::1" });
  });

  test("take allow for prefer, as Bun does", () => {
    expect(settings("postgres://u@h/db?sslmode=allow").sslmode).toBe("prefer");
    expect(settings("postgres://u@h/db?sslmode=prefer").sslmode).toBe("prefer");
    expect(settings("postgres://u@h/db").sslmode).toBe("disable");
  });

  test("give connecting the time Bun was given, or none for 0", () => {
    expect(
      settingsOf(new SQL({ url: "postgres://u@h/db", connectionTimeout: 0.25 }))
        .timeout,
    ).toBe(250);
    expect(
      settingsOf(new SQL({ url: "postgres://u@h/db", connectionTimeout: 0 }))
        .timeout,
    ).toBe(0);
    expect(
      settingsOf(
        new SQL({ url: "postgres://u@h/db", connectionTimeout: 3_000_000 }),
      ).timeout,
    ).toBe(2 ** 31 - 1);
  });

  test("cannot be had of a client given TLS options past its server's name", () => {
    expect(() =>
      settingsOf(
        new SQL({
          url: "postgres://u@h/db?sslmode=verify-full",
          tls: { ca: "x" },
        }),
      ),
    ).toThrow(
      "@tetsujs/sql takes no TLS option of a client past the name of its server, and this one has ca",
    );
  });

  test("cannot be read from a Bun that keeps them otherwise", () => {
    expect(() =>
      settingsOf({ options: { hostname: "h", port: 5432 } } as unknown as SQL),
    ).toThrow("keeps the settings of a client's connection in a form");
    expect(() =>
      settingsOf({
        options: {
          ...new SQL("postgres://u@h/db").options,
          query: "options\0odd\0x\0",
        },
      } as unknown as SQL),
    ).toThrow("in a form @tetsujs/sql does not know");
  });
});

describe("the unix socket of a URL", () => {
  test("is the one path names, in any case, which Bun reaches the server on", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tetsu-sql-socket-"));
    const socket = join(dir, "s.sock");
    let sessions = 0;
    const server = createServer((peer) => {
      sessions += 1;
      peer.once("data", () => {
        peer.end(
          errorResponse({
            S: "FATAL",
            V: "FATAL",
            C: "28000",
            M: "answered on the socket",
          }),
        );
      });
    });

    await new Promise<void>((resolve) => server.listen(socket, resolve));

    try {
      for (const key of ["path", "PATH", "Path"]) {
        const url = `postgres://u@127.0.0.1:1/db?${key}=${encodeURIComponent(socket)}`;
        const client = new SQL(url);

        sessions = 0;

        const error = await client`select 1`.catch((error: unknown) => error);

        await closeCut(client);
        expect(error).toMatchObject({ message: "answered on the socket" });
        expect(sessions).toBeGreaterThan(0);
        expect(socketOf(url)).toBe(socket);
      }
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("is none for an empty path, or none at all", () => {
    expect(socketOf("postgres://u@h/db?path=")).toBeUndefined();
    expect(socketOf("postgres://u@h/db?sslmode=disable")).toBeUndefined();
  });
});

describe("the options of TLS", () => {
  const of = (sslmode: string, host = "db.example") =>
    tlsOptionsOf(settings(`postgres://u@${host}/db?sslmode=${sslmode}`));

  test("check no certificate under prefer and require", () => {
    for (const sslmode of ["prefer", "require"]) {
      expect(of(sslmode)).toEqual({
        host: "db.example",
        servername: "db.example",
        rejectUnauthorized: false,
      });
    }
  });

  test("check the authority under verify-ca, and not the name", () => {
    const options = of("verify-ca");

    expect(options.rejectUnauthorized).toBe(true);
    expect(options.checkServerIdentity).toBeFunction();
    expect(options.checkServerIdentity?.("other.example", {} as never)).toBe(
      undefined,
    );
  });

  test("check the authority and the name under verify-full", () => {
    expect(of("verify-full")).toEqual({
      host: "db.example",
      servername: "db.example",
      rejectUnauthorized: true,
    });
  });

  test("send no name to a server reached by its address, and check it", () => {
    expect(of("verify-full", "10.0.0.7")).toEqual({
      host: "10.0.0.7",
      rejectUnauthorized: true,
    });
    expect(of("verify-full", "[::1]")).toEqual({
      host: "::1",
      rejectUnauthorized: true,
    });
  });
});

describe("a session with Postgres", () => {
  let wire: Wire;
  let orders: number;

  beforeAll(async () => {
    await sql.unsafe(`
      create table orders (
        id int8 generated always as identity primary key,
        customer text not null,
        total numeric(10, 2),
        tags text[]
      );
      create schema elsewhere;
      create table elsewhere.notes (id int4);
    `);
    [{ oid: orders }] = await sql`select 'orders'::regclass::int4 as oid`;
    wire = await Wire.connect(clientOf(url));
  });

  afterAll(async () => {
    await wire.end();
  });

  test("is on the database, as the user, with the URL's parameters", async () => {
    const [{ user }] = await sql`select current_user as user`;
    const other = await Wire.connect(
      clientOf(
        `${url}?application_name=tetsu-wire&options=-c%20search_path%3Delsewhere`,
      ),
    );

    try {
      expect(
        await other.query(
          "select current_database(), current_user, current_setting('application_name'), current_setting('search_path')",
        ),
      ).toEqual([[name, user, "tetsu-wire", "elsewhere"]]);
      expect(await other.prepare("", "select id from notes")).toMatchObject({
        fields: [{ name: "id", type: 23, column: 1 }],
      });
    } finally {
      await other.end();
    }
  });

  test("is described a statement's parameters and columns, with the table and the column of each", async () => {
    expect(
      await wire.prepare(
        "",
        "select o.id, o.total, o.tags, length(o.customer) as size from orders o where o.customer = $1 and o.total > $2",
      ),
    ).toEqual({
      parameters: [25, 1700],
      fields: [
        { name: "id", type: 20, modifier: -1, table: orders, column: 1 },
        {
          name: "total",
          type: 1700,
          modifier: ((10 << 16) | 2) + 4,
          table: orders,
          column: 3,
        },
        { name: "tags", type: 1009, modifier: -1, table: orders, column: 4 },
        { name: "size", type: 23, modifier: -1, table: 0, column: 0 },
      ],
    });
  });

  test("is described a statement prepared with the types it gives, the others inferred", async () => {
    expect(
      await wire.prepare(
        "",
        "select $1 as a, $2 = 1 as b, $3::text as c",
        [20, 0],
      ),
    ).toMatchObject({
      parameters: [20, 23, 25],
      fields: [{ name: "a", type: 20 }, { name: "b", type: 16 }, { name: "c" }],
    });
    expect(
      await wire
        .prepare("", "select $1 as a", [3_000_000_000])
        .catch((error: unknown) => error),
    ).toMatchObject({ message: "cache lookup failed for type 3000000000" });
  });

  test("is told a statement returns no rows, unless it returns some", async () => {
    expect(
      await wire.prepare("", "insert into orders (customer) values ($1)"),
    ).toEqual({ parameters: [25], fields: null });
    expect(
      await wire.prepare(
        "",
        "update orders set total = $1 where id = $2 returning id",
      ),
    ).toEqual({
      parameters: [1700, 20],
      fields: [
        { name: "id", type: 20, modifier: -1, table: orders, column: 1 },
      ],
    });
  });

  test("is told why a statement is refused and where, and goes on", async () => {
    const unknown = await wire
      .prepare("", "select nope from orders")
      .catch((error: unknown) => error);
    const syntax = await wire
      .prepare("", "selec 1")
      .catch((error: unknown) => error);

    expect(unknown).toBeInstanceOf(SQL.PostgresError);
    expect(unknown).toMatchObject({
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "42703",
      position: "8",
      severity: "ERROR",
      message: 'column "nope" does not exist',
    });
    expect(syntax).toMatchObject({
      code: "ERR_POSTGRES_SYNTAX_ERROR",
      errno: "42601",
      position: "1",
    });
    expect(await wire.query("select 1")).toEqual([["1"]]);
  });

  test("cannot prepare two statements as one", async () => {
    await expect(wire.prepare("", "select 1; select 2")).rejects.toMatchObject({
      errno: "42601",
      message: "cannot insert multiple commands into a prepared statement",
    });
  });

  test("prepares a statement under a name that EXPLAIN EXECUTE plans, until it is deallocated", async () => {
    await wire.prepare("planned", "select id from orders where customer = $1");

    // A plan for the NULL given, rather than for any value, would see
    // `customer = NULL` is never true, and leave the table out.
    await wire.query("set plan_cache_mode = force_generic_plan");

    const [[plan]] = (await wire.query(
      "explain (format json) execute planned(null)",
    )) as [[string]];

    await wire.query("reset plan_cache_mode");

    expect(JSON.parse(plan)).toMatchObject([
      { Plan: { "Relation Name": "orders" } },
    ]);
    await expect(wire.prepare("planned", "select 1")).rejects.toMatchObject({
      errno: "42P05",
    });

    await wire.query("deallocate planned");
    expect(await wire.prepare("planned", "select 1")).toMatchObject({
      parameters: [],
    });
    await wire.query("deallocate planned");
  });

  test("reads a plain query's rows as text, and NULL as null", async () => {
    expect(
      await wire.query("select 1 as a, null as b, 'ё' as c, true as d"),
    ).toEqual([["1", null, "ё", "t"]]);
  });

  test("hands back the rows of a plain query's last statement", async () => {
    expect(await wire.query("select 1; select 2 union all select 3")).toEqual([
      ["2"],
      ["3"],
    ]);
    expect(await wire.query("select 1; set application_name = 'x'")).toEqual(
      [],
    );
    expect(await wire.query("")).toEqual([]);
  });

  test("is told why a plain query is refused, and goes on", async () => {
    await expect(wire.query("select 1/0")).rejects.toMatchObject({
      errno: "22012",
      message: "division by zero",
    });
    expect(await wire.query("select 2")).toEqual([["2"]]);
  });

  test("runs requests made at once one after another", async () => {
    const results = await Promise.all([
      wire.query("select 1"),
      wire.prepare("", "select customer from orders"),
      wire.query("select 1/0").catch((error: unknown) => error),
      wire.query("select 3"),
    ]);

    expect(results[0]).toEqual([["1"]]);
    expect(results[1]).toMatchObject({ fields: [{ name: "customer" }] });
    expect(results[2]).toMatchObject({ errno: "22012" });
    expect(results[3]).toEqual([["3"]]);
  });

  test("refuses a text that holds a NUL before sending it, and goes on", async () => {
    await expect(wire.prepare("", "select '\0'")).rejects.toThrow(TypeError);
    await expect(wire.query("select '\0'")).rejects.toThrow(
      "cannot be sent a string that holds a NUL",
    );
    expect(await wire.query("select 4")).toEqual([["4"]]);
  });

  test("ended by the server fails each request with the server's reason", async () => {
    const other = await Wire.connect(clientOf(url));
    const [[pid]] = (await other.query("select pg_backend_pid()")) as [
      [string],
    ];

    await sql`select pg_terminate_backend(${Number(pid)})`;

    while (
      (
        await sql`select count(*)::int as n from pg_stat_activity where pid = ${Number(pid)}`
      )[0].n > 0
    ) {
      await Bun.sleep(10);
    }

    await Bun.sleep(50);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(other.query("select 1")).rejects.toMatchObject({
        errno: "57P01",
        severity: "FATAL",
      });
    }

    await other.end();
  });

  test("ended, fails each request", async () => {
    const other = await Wire.connect(clientOf(url));

    await other.end();
    await expect(other.query("select 1")).rejects.toMatchObject({
      code: "ERR_POSTGRES_CONNECTION_CLOSED",
    });
    await other.end();
  });

  test("is refused with a wrong password, as the server refuses it", async () => {
    const wrong = new URL(url);

    wrong.password = "not-the-password";
    await expect(Wire.connect(clientOf(wrong.href))).rejects.toMatchObject({
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "28P01",
      severity: "FATAL",
    });
  });

  test("cannot be had of a server that is not there", async () => {
    const closed = new URL(url);

    closed.port = "1";
    await expect(Wire.connect(clientOf(closed.href))).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
  });
});

describe("starting a session", () => {
  test("sends the startup parameters Bun sends", async () => {
    const startups: unknown[] = [];
    const stub = await stubServer(async (peer) => {
      startups.push(startupOf(await peer.untyped()));
      peer.send(errorResponse({ S: "FATAL", V: "FATAL", C: "28000", M: "no" }));
    });
    const address = stub.url(
      "options=-c%20search_path%3Dbilling&application_name=x",
    );
    const bun = new SQL({ url: address, connectionTimeout: 1 });

    try {
      await expect(Wire.connect(new SQL(address))).rejects.toMatchObject({
        errno: "28000",
      });
      await bun`select 1`.catch(() => undefined);
    } finally {
      await closeCut(bun);
      await stub.stop();
    }

    expect(startups[0]).toEqual({
      version: 196_608,
      parameters: [
        ["user", "tetsu"],
        ["database", "app"],
        ["client_encoding", "UTF8"],
        ["DateStyle", "ISO, MDY"],
        ["options", "-c search_path=billing"],
        ["application_name", "x"],
      ],
    });
    expect(startups[1]).toEqual(startups[0]);
  });

  test("needs no password when the server asks for none, and ends the session as a client should", async () => {
    let last: unknown;
    const stub = await stubServer(async (peer) => {
      await trust(peer);
      last = await peer.message();
    });

    try {
      await (await Wire.connect(new SQL(stub.url()))).end();
    } finally {
      await stub.stop();
    }

    expect(last).toEqual({ type: "X", body: Buffer.alloc(0) });
  });

  test("sends the password when the server asks for it in clear", async () => {
    let sent: unknown;
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(authentication(3));
      sent = await peer.message();
      peer.send(authentication(0), READY);
    });

    try {
      await (await Wire.connect(new SQL(stub.url()))).end();
    } finally {
      await stub.stop();
    }

    expect(sent).toEqual({ type: "p", body: Buffer.from("secret\0") });
  });

  test("sends the password a function gives, as Bun takes it", async () => {
    let sent: unknown;
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(authentication(3));
      sent = await peer.message();
      peer.send(authentication(0), READY);
    });

    try {
      await (
        await Wire.connect(
          new SQL({ url: stub.url(), password: async () => "from-a-function" }),
        )
      ).end();
    } finally {
      await stub.stop();
    }

    expect(sent).toEqual({ type: "p", body: Buffer.from("from-a-function\0") });
  });

  test("sends the password salted and hashed when the server asks for MD5", async () => {
    let sent: unknown;
    const salt = Buffer.from([1, 2, 3, 250]);
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(authentication(5, salt));
      sent = await peer.message();
      peer.send(authentication(0), READY);
    });

    try {
      await (await Wire.connect(new SQL(stub.url()))).end();
    } finally {
      await stub.stop();
    }

    const md5 = (data: string | Buffer) =>
      createHash("md5").update(data).digest("hex");

    expect(sent).toEqual({
      type: "p",
      body: Buffer.from(
        `md5${md5(Buffer.concat([Buffer.from(md5("secrettetsu")), salt]))}\0`,
      ),
    });
  });

  test("proves the password by SCRAM-SHA-256, and takes the server's proof", async () => {
    let exchange: Awaited<ReturnType<typeof scram>> | undefined;
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      exchange = await scram(peer);
      peer.send(
        authentication(12, Buffer.from(`v=${exchange.signature}`)),
        authentication(0),
        READY,
      );
    });

    try {
      await (await Wire.connect(new SQL(stub.url()))).end();
    } finally {
      await stub.stop();
    }

    expect(exchange).toMatchObject({
      mechanism: "SCRAM-SHA-256",
      proved: true,
    });
    expect(exchange?.first).toMatch(/^n,,n=,r=[A-Za-z0-9+/=]{24}$/);
  });

  test("refuses a server whose SCRAM signature does not prove the password", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      await scram(peer);
      peer.send(
        authentication(
          12,
          Buffer.from(`v=${Buffer.alloc(32).toString("base64")}`),
        ),
        authentication(0),
        READY,
      );
    });

    try {
      await expect(Wire.connect(new SQL(stub.url()))).rejects.toMatchObject({
        code: "ERR_POSTGRES_INVALID_SERVER_SIGNATURE",
      });
    } finally {
      await stub.stop();
    }
  });

  test("refuses a server that ends SCRAM without proving the password", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      await scram(peer);
      peer.send(authentication(0), READY);
    });

    try {
      await expect(Wire.connect(new SQL(stub.url()))).rejects.toMatchObject({
        code: "ERR_POSTGRES_INVALID_SERVER_SIGNATURE",
        message:
          "the server ended SCRAM authentication without proving that it knows the password",
      });
    } finally {
      await stub.stop();
    }
  });

  test("refuses a SCRAM nonce that does not carry on the client's", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(authentication(10, cstring("SCRAM-SHA-256"), Buffer.from([0])));
      await peer.message();
      peer.send(authentication(11, Buffer.from("r=forged,s=c2FsdA==,i=4096")));
    });

    try {
      await expect(Wire.connect(new SQL(stub.url()))).rejects.toMatchObject({
        code: "ERR_POSTGRES_SASL_SIGNATURE_MISMATCH",
      });
    } finally {
      await stub.stop();
    }
  });

  test("refuses a SCRAM nonce the server added nothing to", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(authentication(10, cstring("SCRAM-SHA-256"), Buffer.from([0])));

      const first = (await peer.message()).body.toString();
      const nonce = /r=([^,\0]+)/.exec(first)?.[1];

      peer.send(
        authentication(11, Buffer.from(`r=${nonce},s=c2FsdA==,i=4096`)),
      );
    });

    try {
      await expect(Wire.connect(new SQL(stub.url()))).rejects.toMatchObject({
        code: "ERR_POSTGRES_SASL_SIGNATURE_MISMATCH",
      });
    } finally {
      await stub.stop();
    }
  });

  test("refuses a server that starts SASL twice", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(authentication(10, cstring("SCRAM-SHA-256"), Buffer.from([0])));
      await peer.message();
      peer.send(authentication(10, cstring("SCRAM-SHA-256"), Buffer.from([0])));
    });

    try {
      await expect(Wire.connect(new SQL(stub.url()))).rejects.toMatchObject({
        code: "ERR_POSTGRES_UNEXPECTED_MESSAGE",
      });
    } finally {
      await stub.stop();
    }
  });

  test("answers no other way to authenticate once SCRAM has begun, and sends no password", async () => {
    for (const [code, body] of [
      [3, Buffer.alloc(0)],
      [5, Buffer.from([1, 2, 3, 4])],
      [10, Buffer.concat([cstring("SCRAM-SHA-256"), Buffer.from([0])])],
    ] as const) {
      let sent: unknown = "nothing yet";
      const stub = await stubServer(async (peer) => {
        await peer.untyped();
        peer.send(
          authentication(10, cstring("SCRAM-SHA-256"), Buffer.from([0])),
        );
        await peer.message();
        peer.send(authentication(code, body));
        sent = await peer.message().catch(() => undefined);
      });

      try {
        await expect(Wire.connect(new SQL(stub.url()))).rejects.toMatchObject({
          code: "ERR_POSTGRES_UNEXPECTED_MESSAGE",
        });
        await Bun.sleep(20);
      } finally {
        await stub.stop();
      }

      expect(sent).toBe(undefined);
    }
  });

  test("refuses the session going on before authentication is over", async () => {
    for (const early of [
      READY,
      backend("S", cstring("server_version"), cstring("18.0")),
      backend("K", int32(1), int32(2)),
    ]) {
      const stub = await stubServer(async (peer) => {
        await peer.untyped();
        peer.send(early, authentication(0), READY);
      });

      try {
        await expect(Wire.connect(new SQL(stub.url()))).rejects.toMatchObject({
          code: "ERR_POSTGRES_UNEXPECTED_MESSAGE",
        });
      } finally {
        await stub.stop();
      }
    }

    const midway = await stubServer(async (peer) => {
      await peer.untyped();
      await scram(peer);
      peer.send(READY);
    });

    try {
      await expect(Wire.connect(new SQL(midway.url()))).rejects.toMatchObject({
        code: "ERR_POSTGRES_UNEXPECTED_MESSAGE",
      });
    } finally {
      await midway.stop();
    }
  });

  test("refuses authentication asked for again, after a password or after it is over", async () => {
    for (const script of [
      async (peer: Peer) => {
        await peer.untyped();
        peer.send(authentication(3));
        await peer.message();
        peer.send(authentication(3));
      },
      async (peer: Peer) => {
        await peer.untyped();
        peer.send(authentication(0), authentication(3));
      },
    ]) {
      const stub = await stubServer(script);

      try {
        await expect(Wire.connect(new SQL(stub.url()))).rejects.toMatchObject({
          code: "ERR_POSTGRES_UNEXPECTED_MESSAGE",
        });
      } finally {
        await stub.stop();
      }
    }
  });

  test("refuses SCRAM of more iterations than it computes", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(authentication(10, cstring("SCRAM-SHA-256"), Buffer.from([0])));

      const first = (await peer.message()).body.toString();
      const nonce = /r=([^,\0]+)/.exec(first)?.[1];

      peer.send(
        authentication(
          11,
          Buffer.from(`r=${nonce}server,s=c2FsdA==,i=10000001`),
        ),
      );
    });
    const started = performance.now();

    try {
      await expect(Wire.connect(new SQL(stub.url()))).rejects.toMatchObject({
        code: "ERR_POSTGRES_AUTHENTICATION_FAILED_PBKDF",
        message:
          "the server asks for 10000001 iterations of SCRAM, more than the 10000000 @tetsujs/sql computes",
      });
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      await stub.stop();
    }
  });

  test("refuses a server that asks for SCRAM's proof twice", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      await scram(peer);
      peer.send(authentication(11, Buffer.from("r=again,s=c2FsdA==,i=1")));
    });

    try {
      await expect(Wire.connect(new SQL(stub.url()))).rejects.toMatchObject({
        code: "ERR_POSTGRES_UNEXPECTED_MESSAGE",
      });
    } finally {
      await stub.stop();
    }
  });

  test("fails with the reason the server gives for failing SCRAM", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      await scram(peer);
      peer.send(authentication(12, Buffer.from("e=invalid-proof")));
    });

    try {
      await expect(Wire.connect(new SQL(stub.url()))).rejects.toThrow(
        "the server failed SCRAM authentication: invalid-proof",
      );
    } finally {
      await stub.stop();
    }
  });

  test("refuses SASL that does not offer SCRAM-SHA-256", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(
        authentication(10, cstring("SCRAM-SHA-256-PLUS"), Buffer.from([0])),
      );
    });

    try {
      await expect(Wire.connect(new SQL(stub.url()))).rejects.toMatchObject({
        code: "ERR_POSTGRES_UNSUPPORTED_AUTHENTICATION_METHOD",
        message:
          "the server asks for SASL authentication by SCRAM-SHA-256-PLUS, of which @tetsujs/sql supports none: it supports SCRAM-SHA-256",
      });
    } finally {
      await stub.stop();
    }
  });

  test("refuses a way to authenticate it does not support, naming it", async () => {
    for (const [code, method] of [
      [7, "GSSAPI"],
      [9, "SSPI"],
      [2, "Kerberos V5"],
    ] as const) {
      const stub = await stubServer(async (peer) => {
        await peer.untyped();
        peer.send(authentication(code));
      });

      try {
        await expect(Wire.connect(new SQL(stub.url()))).rejects.toMatchObject({
          code: "ERR_POSTGRES_UNSUPPORTED_AUTHENTICATION_METHOD",
          message: `the server asks for authentication by ${method}, which @tetsujs/sql does not support: it supports a password, MD5 and SCRAM-SHA-256`,
        });
      } finally {
        await stub.stop();
      }
    }
  });

  test("refuses a way to authenticate the protocol does not have", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(authentication(42));
    });

    try {
      await expect(Wire.connect(new SQL(stub.url()))).rejects.toMatchObject({
        code: "ERR_POSTGRES_UNKNOWN_AUTHENTICATION_METHOD",
      });
    } finally {
      await stub.stop();
    }
  });

  test("refuses SCRAM's later steps before its first", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(authentication(11, Buffer.from("r=x,s=c2FsdA==,i=1")));
    });

    try {
      await expect(Wire.connect(new SQL(stub.url()))).rejects.toMatchObject({
        code: "ERR_POSTGRES_UNEXPECTED_MESSAGE",
      });
    } finally {
      await stub.stop();
    }
  });

  test("fails with the server's error when the server refuses the session", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(
        errorResponse({
          S: "FATAL",
          V: "FATAL",
          C: "53300",
          M: "sorry, too many clients already",
        }),
      );
    });

    try {
      const error = await Wire.connect(new SQL(stub.url())).catch(
        (failure: unknown) => failure,
      );

      expect(error).toBeInstanceOf(SQL.PostgresError);
      expect(error).toMatchObject({
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "53300",
        severity: "FATAL",
        message: "sorry, too many clients already",
      });
    } finally {
      await stub.stop();
    }
  });

  test("passes over what needs no answer while it starts", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(
        backend("N", cstring("SNOTICE"), cstring("Mhello"), Buffer.from([0])),
        authentication(0),
        backend("S", cstring("server_version"), cstring("18.0")),
        backend("K", int32(1), int32(2)),
        backend("v", int32(0), int32(0)),
        READY,
      );
    });

    try {
      await (await Wire.connect(new SQL(stub.url()))).end();
    } finally {
      await stub.stop();
    }
  });

  test("reads messages however the connection splits them", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();

      for (const byte of Buffer.concat([authentication(0), READY])) {
        peer.send(Buffer.from([byte]));
        await Bun.sleep(1);
      }
    });

    try {
      await (await Wire.connect(new SQL(stub.url()))).end();
    } finally {
      await stub.stop();
    }
  });

  test("fails when the server closes the connection", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.close();
    });

    try {
      await expect(Wire.connect(new SQL(stub.url()))).rejects.toMatchObject({
        code: "ERR_POSTGRES_CONNECTION_CLOSED",
      });
    } finally {
      await stub.stop();
    }
  });

  test("fails when the server takes longer than Bun would wait, and hangs up", async () => {
    let waiting: Peer | undefined;
    const stub = await stubServer(async (peer) => {
      waiting = peer;
      await peer.untyped();
    });
    const started = performance.now();

    try {
      await expect(
        Wire.connect(new SQL({ url: stub.url(), connectionTimeout: 0.2 })),
      ).rejects.toMatchObject({
        code: "ERR_POSTGRES_CONNECTION_TIMEOUT",
        message: expect.stringMatching(/took longer than 200 ms$/),
      });
      expect(performance.now() - started).toBeLessThan(2000);
      await Bun.sleep(50);
      expect(waiting?.closed).toBe(true);
    } finally {
      await stub.stop();
    }
  });

  test("takes no time given for no limit, not for none", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      await Bun.sleep(50);
      peer.send(authentication(0), READY);
    });

    try {
      await (
        await Wire.connect(new SQL({ url: stub.url(), connectionTimeout: 0 }))
      ).end();
    } finally {
      await stub.stop();
    }
  });

  test("ends on a message the server should not send then", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(backend("D", Buffer.from([0, 0])));
    });

    try {
      await expect(Wire.connect(new SQL(stub.url()))).rejects.toMatchObject({
        code: "ERR_POSTGRES_UNEXPECTED_MESSAGE",
        message:
          'the server sent a message of type "D", which it should not have sent then',
      });
    } finally {
      await stub.stop();
    }
  });

  test("ends on what is not Postgres's protocol", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(Buffer.from("HTTP/1.1 400 Bad Request\r\n\r\n"));
    });

    try {
      await expect(Wire.connect(new SQL(stub.url()))).rejects.toMatchObject({
        code: "ERR_POSTGRES_INVALID_MESSAGE_LENGTH",
      });
    } finally {
      await stub.stop();
    }
  });

  test("ends on a length no message has", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(Buffer.from([0x52, 0, 0, 0, 2]));
    });

    try {
      await expect(Wire.connect(new SQL(stub.url()))).rejects.toMatchObject({
        code: "ERR_POSTGRES_INVALID_MESSAGE_LENGTH",
      });
    } finally {
      await stub.stop();
    }
  });

  test("ends on a message whose body is not as its type says", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(backend("R", Buffer.from([0, 0])));
    });

    try {
      await expect(Wire.connect(new SQL(stub.url()))).rejects.toMatchObject({
        code: "ERR_POSTGRES_INVALID_MESSAGE",
      });
    } finally {
      await stub.stop();
    }
  });
});

describe("a session the server misbehaves in", () => {
  test("passes over a notice that comes while no request waits", async () => {
    let asked: unknown;
    const stub = await stubServer(async (peer) => {
      await trust(peer);
      peer.send(
        backend("N", cstring("SNOTICE"), cstring("Mhello"), Buffer.from([0])),
      );
      asked = await answer(peer, ["1"]);
    });

    try {
      const wire = await Wire.connect(new SQL(stub.url()));

      await Bun.sleep(20);
      expect(await wire.query("select 1")).toEqual([["1"]]);
      await wire.end();
    } finally {
      await stub.stop();
    }

    expect(asked).toBe("select 1");
  });

  test("ends on a message that comes unasked, and fails each request after", async () => {
    const stub = await stubServer(async (peer) => {
      await trust(peer);
      peer.send(backend("D", int16(0)));
    });

    try {
      const wire = await Wire.connect(new SQL(stub.url()));

      await Bun.sleep(20);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(wire.query("select 1")).rejects.toMatchObject({
          code: "ERR_POSTGRES_UNEXPECTED_MESSAGE",
        });
      }
    } finally {
      await stub.stop();
    }
  });

  test("fails a request on a fatal error, without waiting for the server to be ready", async () => {
    const stub = await stubServer(async (peer) => {
      await trust(peer);
      await peer.message();
      peer.send(
        errorResponse({
          S: "ВАЖНО",
          V: "FATAL",
          C: "57P01",
          M: "terminating connection due to administrator command",
        }),
      );
    });

    try {
      const wire = await Wire.connect(new SQL(stub.url()));

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(wire.query("select 1")).rejects.toMatchObject({
          errno: "57P01",
          severity: "FATAL",
        });
      }
    } finally {
      await stub.stop();
    }
  });

  test("reads a count of parameters past 2^15 as the unsigned number it is", async () => {
    const stub = await stubServer(async (peer) => {
      await trust(peer);

      for (let message = 0; message < 3; message += 1) {
        await peer.message();
      }

      const count = Buffer.alloc(2);

      count.writeUInt16BE(40_000);
      peer.send(
        backend("1"),
        backend("t", count, ...Array.from({ length: 40_000 }, () => int32(25))),
        backend("n"),
        READY,
      );
    });

    try {
      const wire = await Wire.connect(new SQL(stub.url()));

      expect((await wire.prepare("", "select")).parameters).toHaveLength(
        40_000,
      );
      await wire.end();
    } finally {
      await stub.stop();
    }
  });

  test("ends the session on an error that comes in one packet with its being ready", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(
        Buffer.concat([
          authentication(0),
          READY,
          errorResponse({
            S: "FATAL",
            V: "FATAL",
            C: "57P01",
            M: "terminating connection due to administrator command",
          }),
        ]),
      );
    });

    try {
      const wire = await Wire.connect(new SQL(stub.url()));

      await expect(wire.query("select 1")).rejects.toMatchObject({
        errno: "57P01",
      });
    } finally {
      await stub.stop();
    }
  });

  test("reads OIDs past 2^31 as the unsigned numbers they are", async () => {
    const stub = await stubServer(async (peer) => {
      await trust(peer);

      for (const type of ["P", "D", "S"]) {
        expect((await peer.message()).type).toBe(type);
      }

      peer.send(
        backend("1"),
        backend("t", int16(1), int32(-1_294_967_296)),
        backend(
          "T",
          int16(1),
          cstring("big"),
          int32(-1_294_967_295),
          int16(-1),
          int32(-1_294_967_294),
          int16(-1),
          int32(-1),
          int16(0),
        ),
        READY,
      );
    });

    try {
      const wire = await Wire.connect(new SQL(stub.url()));

      expect(await wire.prepare("", "select big")).toEqual({
        parameters: [3_000_000_000],
        fields: [
          {
            name: "big",
            type: 3_000_000_002,
            modifier: -1,
            table: 3_000_000_001,
            column: -1,
          },
        ],
      });
      await wire.end();
    } finally {
      await stub.stop();
    }
  });

  test("ends on a message a request does not expect", async () => {
    const stub = await stubServer(async (peer) => {
      await trust(peer);
      await peer.message();
      peer.send(backend("G", Buffer.from([0]), int16(0)));
    });

    try {
      const wire = await Wire.connect(new SQL(stub.url()));

      await expect(wire.query("copy t from stdin")).rejects.toMatchObject({
        code: "ERR_POSTGRES_UNEXPECTED_MESSAGE",
      });
      await expect(wire.query("select 1")).rejects.toMatchObject({
        code: "ERR_POSTGRES_UNEXPECTED_MESSAGE",
      });
    } finally {
      await stub.stop();
    }
  });
});

describe("TLS", () => {
  test("is not asked for under disable", async () => {
    let first: unknown;
    const stub = await stubServer(async (peer) => {
      first = startupOf(await peer.untyped()).version;
      peer.send(authentication(0), READY);
    });

    try {
      await (await Wire.connect(new SQL(stub.url("sslmode=disable")))).end();
    } finally {
      await stub.stop();
    }

    expect(first).toBe(196_608);
  });

  test("is gone without under prefer when the server has none", async () => {
    let request: unknown;
    const stub = await stubServer(async (peer) => {
      request = await peer.untyped();
      peer.send(Buffer.from("N"));
      await trust(peer);
    });

    try {
      await (await Wire.connect(new SQL(stub.url("sslmode=prefer")))).end();
    } finally {
      await stub.stop();
    }

    expect(request).toEqual(SSL_REQUEST);
  });

  test("that the server does not have fails the session under require, verify-ca and verify-full", async () => {
    for (const sslmode of ["require", "verify-ca", "verify-full"]) {
      const stub = await stubServer(async (peer) => {
        await peer.untyped();
        peer.send(Buffer.from("N"));
      });

      try {
        await expect(
          Wire.connect(new SQL(stub.url(`sslmode=${sslmode}`))),
        ).rejects.toMatchObject({
          code: "ERR_POSTGRES_TLS_NOT_AVAILABLE",
          message: `the server does not support TLS, which sslmode=${sslmode} requires`,
        });
      } finally {
        await stub.stop();
      }
    }
  });

  test("carries the session once the server agrees, with any certificate under prefer and require", async () => {
    for (const sslmode of ["prefer", "require"]) {
      let startup: unknown;
      const stub = await stubServer(async (peer) => {
        await peer.untyped();
        peer.send(Buffer.from("S"));
        peer.secure();
        startup = startupOf(await peer.untyped()).parameters[0];
        peer.send(authentication(3));
        expect(await peer.message()).toEqual({
          type: "p",
          body: Buffer.from("secret\0"),
        });
        peer.send(authentication(0), READY);
      });

      try {
        await (
          await Wire.connect(new SQL(stub.url(`sslmode=${sslmode}`)))
        ).end();
      } finally {
        await stub.stop();
      }

      expect(startup).toEqual(["user", "tetsu"]);
    }
  });

  test("refuses a certificate no authority signed under verify-ca and verify-full", async () => {
    for (const sslmode of ["verify-ca", "verify-full"]) {
      const stub = await stubServer(async (peer) => {
        await peer.untyped();
        peer.send(Buffer.from("S"));
        peer.secure();
      });

      try {
        await expect(
          Wire.connect(new SQL(stub.url(`sslmode=${sslmode}`))),
        ).rejects.toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
      } finally {
        await stub.stop();
      }
    }
  });

  test("refuses what the server sends after its yes, before TLS has started", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(Buffer.concat([Buffer.from("S"), authentication(0), READY]));
    });

    try {
      await expect(
        Wire.connect(new SQL(stub.url("sslmode=require"))),
      ).rejects.toMatchObject({
        code: "ERR_POSTGRES_UNEXPECTED_MESSAGE",
        message:
          "the server answered the request for TLS with more than yes or no",
      });
    } finally {
      await stub.stop();
    }
  });

  test("refuses what the server sends after its no", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(Buffer.concat([Buffer.from("N"), authentication(0), READY]));
    });

    try {
      await expect(
        Wire.connect(new SQL(stub.url("sslmode=prefer"))),
      ).rejects.toMatchObject({
        code: "ERR_POSTGRES_UNEXPECTED_MESSAGE",
      });
    } finally {
      await stub.stop();
    }
  });

  test("fails when the server closes the connection instead of answering", async () => {
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.close();
    });

    try {
      await expect(
        Wire.connect(new SQL(stub.url("sslmode=require"))),
      ).rejects.toMatchObject({
        code: "ERR_POSTGRES_CONNECTION_CLOSED",
      });
    } finally {
      await stub.stop();
    }
  });
});

describe("TLS with a certificate of an authority Bun trusts", () => {
  const trusted = getCACertificates("default");

  beforeAll(() => {
    setDefaultCACertificates([...trusted, authority().ca]);
  });

  afterAll(() => {
    setDefaultCACertificates(trusted);
  });

  /**
   * Connects under `sslmode`, to the server by its address or by the name
   * `name`, and what the server was asked for, as SNI.
   */
  async function reach(sslmode: string, name?: string) {
    let servername: string | undefined;
    const stub = await stubServer(async (peer) => {
      await peer.untyped();
      peer.send(Buffer.from("S"));
      peer.secure(authority().server);
      await peer.untyped();
      servername = peer.servername;
      peer.send(authentication(0), READY);
    });

    try {
      const wire = await Wire.connect(
        new SQL({
          url: stub.url(`sslmode=${sslmode}`),
          ...(name === undefined ? {} : { tls: { serverName: name } }),
        }),
      );

      await wire.end();

      return { connected: true, servername };
    } catch (error) {
      return { connected: false, code: (error as { code?: unknown }).code };
    } finally {
      await stub.stop().catch(() => undefined);
    }
  }

  test("is taken under verify-full for the name it is for, which is sent as SNI", async () => {
    expect(await reach("verify-full", "localhost")).toEqual({
      connected: true,
      servername: "localhost",
    });
  });

  test("is refused under verify-full for an address it is not for", async () => {
    expect(await reach("verify-full")).toEqual({
      connected: false,
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
  });

  test("is taken under verify-ca whatever the name, and an address is sent no SNI", async () => {
    expect(await reach("verify-ca")).toEqual({
      connected: true,
      servername: undefined,
    });
  });
});
