/**
 * A client of Postgres's own protocol, as small as the generator needs:
 * Postgres describes a query without running it — the types of its
 * parameters, and its columns with the table and the column each is taken
 * from — and Bun.SQL does not hand that on.
 *
 * It connects where a Bun.SQL client would, with the settings Bun resolved
 * for that client from its URL and the environment: the same server,
 * database, user and password, the same `sslmode`, and the same startup
 * parameters, such as `options` with a `search_path`. Bun keeps part of
 * them in a form it does not document: the tests hold this module to Bun's
 * own, and a Bun that keeps them otherwise is refused with an error rather
 * than connected to elsewhere. It connects over TCP only: Bun keeps a
 * unix socket, which `path` names in a URL, out of a client's settings,
 * and {@link socketOf} reads it from the URL, for the generator to refuse
 * such a URL.
 *
 * It authenticates by password, MD5 or SCRAM-SHA-256, and prepares a
 * query under a name, which `EXPLAIN EXECUTE` can then plan, or runs a
 * plain query, whose values it reads as text. Requests run one after
 * another.
 *
 * @module
 */

import {
  createHash,
  createHmac,
  pbkdf2,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Socket } from "node:net";
import { connect as connectTcp, isIP } from "node:net";
import type { Duplex } from "node:stream";
import type { ConnectionOptions } from "node:tls";
import { connect as connectTls } from "node:tls";
import { promisify } from "node:util";
import { SQL } from "bun";

/** A column of the rows a statement returns, as Postgres describes it. */
export interface Field {
  /** Its name. */
  readonly name: string;

  /** The OID of its type. */
  readonly type: number;

  /**
   * Its type's modifier, as Postgres keeps it — a `varchar(10)`'s is 14 —
   * or -1 for none.
   */
  readonly modifier: number;

  /** The OID of the table it is a column of, or 0 when it is not one. */
  readonly table: number;

  /**
   * Its number in that table — below 0 for a system column, such as
   * `ctid` — or 0 when it is not a column of one.
   */
  readonly column: number;
}

/** A prepared statement, as Postgres describes it. */
export interface Statement {
  /** The OIDs of the types of its parameters, `$1` first. */
  readonly parameters: readonly number[];

  /** The columns of the rows it returns, or `null` when it returns none. */
  readonly fields: readonly Field[] | null;
}

/** A row of a plain query, its values as text, and `null` for NULL. */
export type Row = readonly (string | null)[];

/** The `sslmode`s, by the number Bun keeps each as. */
const SSL_MODES = [
  "disable",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
] as const;

/**
 * What `sslmode` says of TLS: `disable` — none; `prefer` — when the server
 * has it; `require` — always, and any certificate; `verify-ca` — always,
 * and a certificate of an authority Bun trusts; `verify-full` — that, of
 * the host connected to. Bun takes `allow` for `prefer`.
 */
export type SslMode = (typeof SSL_MODES)[number];

/** Where and how to connect: what Bun resolved for a client. */
export interface Settings {
  /** The server's host name or address, without the brackets of IPv6. */
  readonly host: string;

  /** The server's port. */
  readonly port: number;

  /** The user to connect as. */
  readonly user: string;

  /** The user's password, or what gives it, as Bun takes it. */
  readonly password: string | (() => string | Promise<string>);

  /** The database to connect to. */
  readonly database: string;

  /** Whether and how the connection is encrypted. */
  readonly sslmode: SslMode;

  /** The name the server's certificate is for, sent to it unless an address. */
  readonly servername: string;

  /** The URL's other parameters, sent to the server as Bun sends them. */
  readonly parameters: readonly (readonly [string, string])[];

  /** How long connecting may take, in milliseconds, or 0 for as long as it takes. */
  readonly timeout: number;
}

/** A client's settings as Bun 1.4.3 keeps them, which nothing promises. */
interface Resolved {
  readonly hostname?: unknown;
  readonly port?: unknown;
  readonly username?: unknown;
  readonly password?: unknown;
  readonly database?: unknown;
  readonly tls?: unknown;
  readonly sslMode?: unknown;
  readonly query?: unknown;
  readonly connectionTimeout?: unknown;
}

/** A message of the server's: its type, and its body. */
interface Message {
  readonly type: string;
  readonly body: Buffer;
}

/** How long connecting takes at most when Bun was given no time. */
const CONNECT_MS = 30_000;

/** The longest time a timer waits: one given a longer time fires at once. */
const TIMER_MAX_MS = 2 ** 31 - 1;

/**
 * The most iterations of SCRAM the client computes: Postgres asks for
 * 4096 by default, and a server that asks for billions holds the process
 * for minutes.
 */
const ITERATIONS_MAX = 10_000_000;

/** How long ending the session waits for the server to close it. */
const END_MS = 5000;

/**
 * How long a message of the server's can be: anything longer is not
 * Postgres speaking, which never sends a message of a gigabyte.
 */
const MESSAGE_MAX = 2 ** 30;

/** Version 3.0 of the protocol, as the startup message names it. */
const PROTOCOL = 196_608;

/** The request to start TLS: its length, then its code. */
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);

/**
 * The messages that need no answer whenever the server sends them, once
 * the session has started: a notice, a parameter's new value, and a
 * notification.
 */
const ASIDE: ReadonlySet<string> = new Set(["N", "S", "A"]);

/** The severities of an error that ends the session. */
const FATAL: ReadonlySet<string | undefined> = new Set(["FATAL", "PANIC"]);

/**
 * Where authentication stands: the startup message `asked`, a password
 * `sent`, SCRAM's `first` and `final` messages sent, the server `proved`
 * it knows the password, or `done`.
 */
type Stage = "asked" | "sent" | "first" | "final" | "proved" | "done";

/**
 * The authentication requests the client answers at each stage, by their
 * codes: at first, the end of it or a way to authenticate; then only what
 * comes after what it answered; none once it is done.
 */
const NEXT: Readonly<Record<Stage, readonly number[]>> = {
  asked: [0, 3, 5, 10],
  sent: [0],
  first: [0, 11],
  final: [0, 12],
  proved: [0],
  done: [],
};

/**
 * The fields of an error the server sends, by their code, as Bun.SQL names
 * them: a `PostgresError` of this client is one of Bun's.
 */
const FIELDS: Readonly<Record<string, string>> = {
  C: "errno",
  D: "detail",
  H: "hint",
  P: "position",
  p: "internalPosition",
  q: "internalQuery",
  W: "where",
  s: "schema",
  t: "table",
  c: "column",
  d: "dataType",
  n: "constraint",
  F: "file",
  L: "line",
  R: "routine",
};

const derive = promisify(pbkdf2);

/**
 * The settings Bun resolved for `sql`: from its URL, and for what the URL
 * leaves out, from `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and
 * `PGSSLMODE`; its database from `PGDATABASE`, which Bun takes over the
 * URL's, unless the client names one, as the package's own clients do.
 *
 * @throws {Error} when Bun keeps them in a form this module does not know,
 * or the client was given TLS options past the name of its server, which
 * this module does not take.
 */
export function settingsOf(sql: SQL): Settings {
  const {
    hostname,
    port,
    username,
    password,
    database,
    tls,
    sslMode,
    query,
    connectionTimeout,
  } = sql.options as Resolved;
  const sslmode = typeof sslMode === "number" ? SSL_MODES[sslMode] : undefined;
  const values =
    typeof query === "string" && query.endsWith("\0")
      ? query.slice(0, -1).split("\0")
      : query === ""
        ? []
        : undefined;

  if (
    typeof hostname !== "string" ||
    typeof port !== "number" ||
    typeof username !== "string" ||
    (typeof password !== "string" && typeof password !== "function") ||
    typeof database !== "string" ||
    sslmode === undefined ||
    values === undefined ||
    values.length % 2 !== 0
  ) {
    throw new Error(
      `Bun ${Bun.version} keeps the settings of a client's connection in a form @tetsujs/sql does not know`,
    );
  }

  const options = typeof tls === "object" && tls !== null ? tls : {};
  const others = Object.keys(options).filter((key) => key !== "serverName");

  if (others.length > 0) {
    throw new Error(
      `@tetsujs/sql takes no TLS option of a client past the name of its server, and this one has ${others.join(", ")}`,
    );
  }

  const host = unbracketed(hostname);
  const serverName = (options as { serverName?: unknown }).serverName;
  const parameters: (readonly [string, string])[] = [];

  for (let index = 0; index < values.length; index += 2) {
    parameters.push([values[index] as string, values[index + 1] as string]);
  }

  return {
    host,
    port,
    user: username,
    password: password as Settings["password"],
    database,
    sslmode,
    servername: typeof serverName === "string" ? unbracketed(serverName) : host,
    parameters,
    timeout:
      typeof connectionTimeout === "number"
        ? Math.min(connectionTimeout, TIMER_MAX_MS)
        : CONNECT_MS,
  };
}

/**
 * The unix socket Bun.SQL reaches the server of `url` on: the one `path`
 * names, in any case, unless it is empty. Bun keeps it out of a client's
 * settings, so {@link settingsOf} does not see it, and a {@link Wire}
 * would reach the host and the port of the URL instead, which may be
 * another server.
 */
export function socketOf(url: string): string | undefined {
  for (const [key, value] of new URL(url).searchParams) {
    if (key.toLowerCase() === "path" && value !== "") {
      return value;
    }
  }

  return undefined;
}

/**
 * The options TLS starts with under `settings`: the certificate checked as
 * `sslmode` says, against the name the server is reached by, which is
 * sent to it, as SNI, unless it is an address.
 */
export function tlsOptionsOf(settings: Settings): ConnectionOptions {
  const { servername, sslmode } = settings;

  return {
    host: servername,
    ...(isIP(servername) === 0 ? { servername } : {}),
    rejectUnauthorized: sslmode === "verify-ca" || sslmode === "verify-full",
    ...(sslmode === "verify-ca"
      ? { checkServerIdentity: () => undefined }
      : {}),
  };
}

/** A session with the server, on a connection of its own. */
export class Wire {
  private readonly socket: Duplex;

  /** What has come in that is not a whole message yet. */
  private pending: Buffer = Buffer.alloc(0);

  /** The messages that have come in that nothing has asked for yet. */
  private readonly messages: Message[] = [];

  /** The request waiting for the next message, while one does. */
  private waiting:
    | {
        readonly resolve: (message: Message) => void;
        readonly reject: (error: unknown) => void;
      }
    | undefined;

  /** Why the session is over, once it is. */
  private ended: unknown;

  /**
   * Whether the session starts, or a request waits on the server, up to
   * the server's saying it is ready: a message that comes after that, even
   * in the same packet, comes of the server's accord.
   */
  private busy = true;

  /** The request that runs last, which the next one waits for. */
  private last: Promise<unknown> = Promise.resolve();

  /**
   * Connects as `sql` would, with the settings Bun resolved for it, and
   * starts a session: by the time it resolves, the server is ready for a
   * request.
   *
   * @throws {SQL.PostgresError} when the server refuses the session, with its
   * SQLSTATE in `errno`, or when it cannot be held to what `sslmode` asks,
   * cannot be authenticated with, or takes longer than Bun would wait.
   * @throws {Error} when the server cannot be reached, or its certificate is
   * not one `sslmode` accepts: the error of the socket, with its `code`.
   */
  static async connect(sql: SQL): Promise<Wire> {
    const settings = settingsOf(sql);
    const password =
      typeof settings.password === "function"
        ? await settings.password()
        : settings.password;
    let socket: Duplex | undefined;
    let timer: Timer | undefined;

    const establish = async (): Promise<Wire> => {
      const raw = connectTcp({
        host: settings.host,
        port: settings.port,
        noDelay: true,
      });

      socket = raw;
      await opened(raw);
      socket = await secured(raw, settings);

      const wire = new Wire(socket);

      await wire.start(settings, password);

      return wire;
    };

    try {
      if (settings.timeout === 0) {
        return await establish();
      }

      return await Promise.race([
        establish(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new SQL.PostgresError(
                `connecting to ${settings.host}:${settings.port} took longer than ${settings.timeout} ms`,
                { code: "ERR_POSTGRES_CONNECTION_TIMEOUT" },
              ),
            );
          }, settings.timeout);
        }),
      ]);
    } catch (error) {
      socket?.destroy();

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private constructor(socket: Duplex) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.received(chunk);
    });
    socket.on("error", (error) => {
      this.fail(error);
    });
    socket.on("close", () => {
      this.fail(
        new SQL.PostgresError("the connection to the server was closed", {
          code: "ERR_POSTGRES_CONNECTION_CLOSED",
        }),
      );
    });
    socket.resume();
  }

  /**
   * Prepares `text` as the statement `name`, and describes it. A statement
   * of that name has to be deallocated first; the unnamed one, `""`, is
   * replaced, but cannot be run by SQL's `EXECUTE`.
   *
   * The server infers the type of each parameter, but for those `types`
   * gives by their OIDs, `$1` first; an OID of 0 leaves that one to infer.
   *
   * @throws {SQL.PostgresError} when the server refuses it, as with a
   * syntax error, with its SQLSTATE in `errno` and where it is in
   * `position`: the session goes on.
   * @throws {TypeError} when `name` or `text` holds a NUL, before anything
   * is sent.
   */
  async prepare(
    name: string,
    text: string,
    types: readonly number[] = [],
  ): Promise<Statement> {
    const request = Buffer.concat([
      framed(
        "P",
        Buffer.concat([
          cstring(name),
          cstring(text),
          uint16(types.length),
          ...types.map(oid),
        ]),
      ),
      framed("D", Buffer.concat([Buffer.from("S"), cstring(name)])),
      framed("S"),
    ]);
    let parameters: readonly number[] = [];
    let fields: readonly Field[] | null = null;

    await this.exchange(request, (message) => {
      switch (message.type) {
        case "1":
          return true;
        case "t":
          parameters = parametersOf(message.body);

          return true;
        case "T":
          fields = fieldsOf(message.body);

          return true;
        case "n":
          fields = null;

          return true;
        default:
          return false;
      }
    });

    return { parameters, fields };
  }

  /**
   * Runs `text` as a plain query, and resolves to the rows of its last
   * statement, as text.
   *
   * @throws {SQL.PostgresError} when the server refuses it: the session
   * goes on.
   */
  async query(text: string): Promise<Row[]> {
    const request = framed("Q", cstring(text));
    let rows: Row[] = [];
    let last: Row[] = [];

    await this.exchange(request, (message) => {
      switch (message.type) {
        case "T":
          rows = [];

          return true;
        case "D":
          rows.push(rowOf(message.body));

          return true;
        case "C":
          last = rows;
          rows = [];

          return true;
        case "I":
          return true;
        default:
          return false;
      }
    });

    return last;
  }

  /** Ends the session, as a client should, and closes the connection. */
  async end(): Promise<void> {
    await this.last;

    if (this.ended !== undefined) {
      return;
    }

    let timer: Timer | undefined;

    await Promise.race([
      new Promise<void>((resolve) => {
        this.socket.once("close", () => {
          resolve();
        });
        this.socket.end(framed("X"));
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          this.socket.destroy();
          resolve();
        }, END_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  /**
   * Starts the session: the startup message, the authentication the
   * server asks for, then its parameters, up to its being ready.
   *
   * Authentication goes in the order libpq holds a server to, and a server
   * that strays from it is refused: once SCRAM has begun, only its next
   * step, so that no password goes out in another form; its end only once
   * the server has proved it knows the password; and nothing of the
   * session — a parameter, the key to cancel it, its being ready — before
   * authentication is over. The password goes into SCRAM as it is,
   * without SASLprep, as Bun, postgres.js and node-postgres send it: that
   * differs only for a password SASLprep changes, which those clients
   * cannot use either.
   */
  private async start(settings: Settings, password: string): Promise<void> {
    this.socket.write(startupOf(settings));

    let stage: Stage = "asked";
    let scram: Scram | undefined;

    for (;;) {
      const message = await this.next();

      switch (message.type) {
        case "R": {
          const reader = new Reader(message.body);
          const code = reader.int32();

          if (!NEXT[stage].includes(code)) {
            throw stage === "asked" && code !== 11 && code !== 12
              ? unsupported(code)
              : unexpected("R");
          }

          if (code === 0) {
            if (stage === "first" || stage === "final") {
              throw new SQL.PostgresError(
                "the server ended SCRAM authentication without proving that it knows the password",
                { code: "ERR_POSTGRES_INVALID_SERVER_SIGNATURE" },
              );
            }

            stage = "done";
          } else if (code === 3) {
            this.socket.write(framed("p", cstring(password)));
            stage = "sent";
          } else if (code === 5) {
            this.socket.write(
              framed(
                "p",
                cstring(md5Of(password, settings.user, reader.rest())),
              ),
            );
            stage = "sent";
          } else if (code === 10) {
            scram = new Scram(password, mechanismsOf(reader));
            this.socket.write(
              framed(
                "p",
                Buffer.concat([
                  cstring("SCRAM-SHA-256"),
                  int32(Buffer.byteLength(scram.first)),
                  Buffer.from(scram.first),
                ]),
              ),
            );
            stage = "first";
          } else if (code === 11 && scram !== undefined) {
            this.socket.write(
              framed("p", Buffer.from(await scram.final(reader.text()))),
            );
            stage = "final";
          } else if (code === 12 && scram !== undefined) {
            scram.verify(reader.text());
            stage = "proved";
          } else {
            throw unexpected("R");
          }

          break;
        }
        case "E":
          throw errorOf(message.body);
        case "N":
        case "v":
          break;
        case "S":
        case "K":
          if (stage !== "done") {
            throw unexpected(message.type);
          }

          break;
        case "Z":
          if (stage !== "done") {
            throw unexpected(message.type);
          }

          return;
        default:
          throw unexpected(message.type);
      }
    }
  }

  /**
   * Sends `request`, then hands each message the server answers with to
   * `answer`, which says whether it was one it expects, up to the server's
   * being ready again. A refusal is thrown then, the session going on;
   * anything else that goes wrong ends it.
   */
  private exchange(
    request: Buffer,
    answer: (message: Message) => boolean,
  ): Promise<void> {
    const run = this.last.then(async () => {
      if (this.ended !== undefined) {
        throw this.ended;
      }

      let refusal: SQL.PostgresError | undefined;

      this.busy = true;

      try {
        this.socket.write(request);

        for (;;) {
          const message = await this.next();

          if (message.type === "Z") {
            break;
          }

          if (message.type === "E") {
            refusal = errorOf(message.body);

            if (FATAL.has(refusal.severity)) {
              throw refusal;
            }
          } else if (!answer(message) && !ASIDE.has(message.type)) {
            throw unexpected(message.type);
          }
        }
      } catch (error) {
        this.fail(error);

        throw error;
      }

      if (refusal !== undefined) {
        throw refusal;
      }
    });

    this.last = run.catch(() => undefined);

    return run;
  }

  /** The next message of the server's, once it has come in whole. */
  private next(): Promise<Message> {
    const message = this.messages.shift();

    if (message !== undefined) {
      return Promise.resolve(message);
    }

    if (this.ended !== undefined) {
      return Promise.reject(this.ended);
    }

    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  /** Takes in what has come, as the whole messages it completes. */
  private received(chunk: Buffer): void {
    this.pending =
      this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);

    while (this.ended === undefined && this.pending.length >= 5) {
      const length = this.pending.readInt32BE(1);

      if (length < 4 || length > MESSAGE_MAX) {
        this.fail(
          new SQL.PostgresError(
            "the server sent what is not a message of Postgres's protocol",
            { code: "ERR_POSTGRES_INVALID_MESSAGE_LENGTH" },
          ),
        );

        return;
      }

      if (this.pending.length < length + 1) {
        return;
      }

      const message = {
        type: String.fromCharCode(this.pending[0] as number),
        body: this.pending.subarray(5, length + 1),
      };

      this.pending = this.pending.subarray(length + 1);

      if (!this.busy) {
        this.idle(message);

        continue;
      }

      if (message.type === "Z") {
        this.busy = false;
      }

      if (this.waiting === undefined) {
        this.messages.push(message);
      } else {
        const { resolve } = this.waiting;

        this.waiting = undefined;
        resolve(message);
      }
    }
  }

  /**
   * Takes a message that came while nothing waits on the server: a notice
   * or a parameter's new value, which it passes over; an error, which is
   * the server ending the session, as when an administrator terminates
   * it, and the reason requests then fail with; or anything else, which
   * ends the session.
   */
  private idle(message: Message): void {
    if (ASIDE.has(message.type)) {
      return;
    }

    try {
      this.fail(
        message.type === "E" ? errorOf(message.body) : unexpected(message.type),
      );
    } catch (error) {
      this.fail(error);
    }
  }

  /** Ends the session for `error`, which every request from now on fails with. */
  private fail(error: unknown): void {
    if (this.ended !== undefined) {
      return;
    }

    this.ended = error;
    this.socket.destroy();

    const waiting = this.waiting;

    this.waiting = undefined;
    waiting?.reject(error);
  }
}

/**
 * The client's side of SCRAM-SHA-256, by RFC 5802 and RFC 7677, without
 * channel binding: the client proves it knows the password, and the server
 * proves it does as well.
 */
class Scram {
  /** The first message, which carries the client's half of the nonce. */
  readonly first: string;

  /** Whether the server has proved it knows the password. */
  verified = false;

  private readonly password: string;
  private readonly nonce: string;

  /** The signature the server proves itself with, once it can be known. */
  private signature: Buffer | undefined;

  /**
   * @throws {SQL.PostgresError} when the server does not offer
   * SCRAM-SHA-256 among `mechanisms`.
   */
  constructor(password: string, mechanisms: readonly string[]) {
    if (!mechanisms.includes("SCRAM-SHA-256")) {
      throw new SQL.PostgresError(
        `the server asks for SASL authentication by ${mechanisms.join(", ")}, of which @tetsujs/sql supports none: it supports SCRAM-SHA-256`,
        { code: "ERR_POSTGRES_UNSUPPORTED_AUTHENTICATION_METHOD" },
      );
    }

    this.password = password;
    this.nonce = randomBytes(18).toString("base64");
    this.first = `n,,n=,r=${this.nonce}`;
  }

  /**
   * The final message, which proves the client knows the password, made
   * from the server's first one; and the signature that proves the server
   * does, which {@link verify} then expects.
   */
  async final(serverFirst: string): Promise<string> {
    if (this.signature !== undefined) {
      throw unexpected("R");
    }

    const attributes = attributesOf(serverFirst);
    const nonce = attributes.get("r");
    const salt = attributes.get("s");
    const iterations = Number(attributes.get("i"));

    if (
      nonce === undefined ||
      !nonce.startsWith(this.nonce) ||
      nonce.length === this.nonce.length ||
      salt === undefined ||
      !Number.isSafeInteger(iterations) ||
      iterations < 1
    ) {
      throw new SQL.PostgresError(
        "the server's SCRAM message does not carry on the client's nonce with a salt and an iteration count",
        { code: "ERR_POSTGRES_SASL_SIGNATURE_MISMATCH" },
      );
    }

    if (iterations > ITERATIONS_MAX) {
      throw new SQL.PostgresError(
        `the server asks for ${iterations} iterations of SCRAM, more than the ${ITERATIONS_MAX} @tetsujs/sql computes`,
        { code: "ERR_POSTGRES_AUTHENTICATION_FAILED_PBKDF" },
      );
    }

    const salted = await derive(
      this.password,
      Buffer.from(salt, "base64"),
      iterations,
      32,
      "sha256",
    );
    const clientKey = hmac(salted, "Client Key");
    const withoutProof = `c=biws,r=${nonce}`;
    const message = `${this.first.slice(3)},${serverFirst},${withoutProof}`;
    const signature = hmac(
      createHash("sha256").update(clientKey).digest(),
      message,
    );
    const proof = Buffer.from(
      clientKey.map((byte, index) => byte ^ (signature[index] as number)),
    );

    this.signature = hmac(hmac(salted, "Server Key"), message);

    return `${withoutProof},p=${proof.toString("base64")}`;
  }

  /**
   * Checks the server's last message proves it knows the password.
   *
   * @throws {SQL.PostgresError} when it does not, or reports a failure.
   */
  verify(serverFinal: string): void {
    const attributes = attributesOf(serverFinal);
    const failure = attributes.get("e");

    if (failure !== undefined) {
      throw new SQL.PostgresError(
        `the server failed SCRAM authentication: ${failure}`,
        { code: "ERR_POSTGRES_SASL_SIGNATURE_MISMATCH" },
      );
    }

    const signature = Buffer.from(attributes.get("v") ?? "", "base64");

    if (
      this.signature === undefined ||
      signature.length !== this.signature.length ||
      !timingSafeEqual(signature, this.signature)
    ) {
      throw new SQL.PostgresError(
        "the server's SCRAM signature does not prove that it knows the password",
        { code: "ERR_POSTGRES_INVALID_SERVER_SIGNATURE" },
      );
    }

    this.verified = true;
  }
}

/** Reads the fields of a message's body, one after another. */
class Reader {
  private readonly body: Buffer;
  private offset = 0;

  constructor(body: Buffer) {
    this.body = body;
  }

  byte(): number {
    return this.body.readUInt8(this.take(1));
  }

  int16(): number {
    return this.body.readInt16BE(this.take(2));
  }

  /** A count, which is unsigned. */
  uint16(): number {
    return this.body.readUInt16BE(this.take(2));
  }

  int32(): number {
    return this.body.readInt32BE(this.take(4));
  }

  /** An OID, which is unsigned. */
  oid(): number {
    return this.body.readUInt32BE(this.take(4));
  }

  /** A string ended by a NUL, as UTF-8. */
  cstring(): string {
    const end = this.body.indexOf(0, this.offset);

    if (end === -1) {
      throw malformed();
    }

    const value = this.body.toString("utf8", this.offset, end);

    this.offset = end + 1;

    return value;
  }

  /** The next `length` bytes, as UTF-8. */
  string(length: number): string {
    const start = this.take(length);

    return this.body.toString("utf8", start, start + length);
  }

  /** The rest of the body. */
  rest(): Buffer {
    const value = this.body.subarray(this.offset);

    this.offset = this.body.length;

    return value;
  }

  /** The rest of the body, as UTF-8. */
  text(): string {
    return this.rest().toString("utf8");
  }

  /**
   * Moves past the next `length` bytes, and returns where they start.
   *
   * @throws {SQL.PostgresError} when the body ends before them.
   */
  private take(length: number): number {
    const start = this.offset;

    if (length < 0 || start + length > this.body.length) {
      throw malformed();
    }

    this.offset += length;

    return start;
  }
}

/** Resolves once `socket` is connected, or rejects with why it is not. */
function opened(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve();
    });
  });
}

/**
 * The connection the session runs on: `socket` itself, or TLS on it, as
 * `sslmode` says. The server answers the request for TLS with one byte,
 * and anything it sends after that byte, before TLS has started, is
 * refused, as libpq refuses it: it could be another's, slipped in.
 */
async function secured(socket: Socket, settings: Settings): Promise<Duplex> {
  const { sslmode } = settings;

  if (sslmode === "disable") {
    return socket;
  }

  const answer = await new Promise<Buffer>((resolve, reject) => {
    const close = () => {
      reject(
        new SQL.PostgresError(
          "the server closed the connection instead of answering the request for TLS",
          { code: "ERR_POSTGRES_CONNECTION_CLOSED" },
        ),
      );
    };

    socket.once("error", reject);
    socket.once("close", close);
    socket.once("data", (chunk: Buffer) => {
      socket.pause();
      socket.off("error", reject);
      socket.off("close", close);
      resolve(chunk);
    });
    socket.write(SSL_REQUEST);
  });

  if (answer.length === 1 && answer[0] === 0x4e) {
    if (sslmode === "prefer") {
      return socket;
    }

    throw new SQL.PostgresError(
      `the server does not support TLS, which sslmode=${sslmode} requires`,
      { code: "ERR_POSTGRES_TLS_NOT_AVAILABLE" },
    );
  }

  if (answer.length !== 1 || answer[0] !== 0x53) {
    throw new SQL.PostgresError(
      "the server answered the request for TLS with more than yes or no",
      { code: "ERR_POSTGRES_UNEXPECTED_MESSAGE" },
    );
  }

  const secure = connectTls({ socket, ...tlsOptionsOf(settings) });

  socket.on("error", (error) => {
    secure.destroy(error);
  });

  await new Promise<void>((resolve, reject) => {
    secure.once("error", reject);
    secure.once("secureConnect", () => {
      secure.off("error", reject);
      resolve();
    });
  });

  return secure;
}

/**
 * The startup message, as Bun sends it: the user, the database, UTF-8 and
 * Bun's date style, then the URL's other parameters.
 */
function startupOf(settings: Settings): Buffer {
  const body = Buffer.concat([
    int32(PROTOCOL),
    ...[
      ["user", settings.user],
      ["database", settings.database],
      ["client_encoding", "UTF8"],
      ["DateStyle", "ISO, MDY"],
      ...settings.parameters,
    ]
      .flat()
      .map(cstring),
    Buffer.from([0]),
  ]);

  return Buffer.concat([int32(body.length + 4), body]);
}

/** A message to the server: its type, its length, then `body`. */
function framed(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(5);

  head.write(type, 0, "latin1");
  head.writeInt32BE(body.length + 4, 1);

  return Buffer.concat([head, body]);
}

/**
 * A string as Postgres reads one: UTF-8, ended by a NUL.
 *
 * @throws {TypeError} when it holds a NUL, which would end it early.
 */
function cstring(text: string): Buffer {
  if (text.includes("\0")) {
    throw new TypeError(
      "Postgres cannot be sent a string that holds a NUL character",
    );
  }

  return Buffer.from(`${text}\0`, "utf8");
}

function uint16(value: number): Buffer {
  const bytes = Buffer.alloc(2);

  bytes.writeUInt16BE(value);

  return bytes;
}

function int32(value: number): Buffer {
  const bytes = Buffer.alloc(4);

  bytes.writeInt32BE(value);

  return bytes;
}

/** An OID, which is unsigned. */
function oid(value: number): Buffer {
  const bytes = Buffer.alloc(4);

  bytes.writeUInt32BE(value);

  return bytes;
}

/** The password MD5 authentication sends: salted, hashed twice. */
function md5Of(password: string, user: string, salt: Buffer): string {
  const inner = createHash("md5").update(password).update(user).digest("hex");

  return `md5${createHash("md5").update(inner).update(salt).digest("hex")}`;
}

function hmac(key: Buffer, text: string): Buffer {
  return createHmac("sha256", key).update(text).digest();
}

/** The SASL mechanisms the server offers. */
function mechanismsOf(reader: Reader): string[] {
  const mechanisms: string[] = [];

  for (let name = reader.cstring(); name !== ""; name = reader.cstring()) {
    mechanisms.push(name);
  }

  return mechanisms;
}

/** The attributes of a SCRAM message, `r=…,s=…`, by their names. */
function attributesOf(message: string): Map<string, string> {
  const attributes = new Map<string, string>();

  for (const attribute of message.split(",")) {
    const equals = attribute.indexOf("=");

    if (equals > 0) {
      attributes.set(attribute.slice(0, equals), attribute.slice(equals + 1));
    }
  }

  return attributes;
}

/** The types of a statement's parameters, from a ParameterDescription. */
function parametersOf(body: Buffer): number[] {
  const reader = new Reader(body);
  const count = reader.uint16();
  const parameters: number[] = [];

  for (let index = 0; index < count; index += 1) {
    parameters.push(reader.oid());
  }

  return parameters;
}

/** The columns of a statement's rows, from a RowDescription. */
function fieldsOf(body: Buffer): Field[] {
  const reader = new Reader(body);
  const count = reader.uint16();
  const fields: Field[] = [];

  for (let index = 0; index < count; index += 1) {
    const name = reader.cstring();
    const table = reader.oid();
    const column = reader.int16();
    const type = reader.oid();

    reader.int16();

    const modifier = reader.int32();

    reader.int16();
    fields.push({ name, type, modifier, table, column });
  }

  return fields;
}

/** A row of a plain query, from a DataRow. */
function rowOf(body: Buffer): Row {
  const reader = new Reader(body);
  const count = reader.uint16();
  const row: (string | null)[] = [];

  for (let index = 0; index < count; index += 1) {
    const length = reader.int32();

    row.push(length === -1 ? null : reader.string(length));
  }

  return row;
}

/** The error an ErrorResponse describes, as Bun.SQL makes it. */
function errorOf(body: Buffer): SQL.PostgresError {
  const reader = new Reader(body);
  const fields = new Map<string, string>();

  for (let code = reader.byte(); code !== 0; code = reader.byte()) {
    fields.set(String.fromCharCode(code), reader.cstring());
  }

  const options: Record<string, string> = {
    code:
      fields.get("C") === "42601"
        ? "ERR_POSTGRES_SYNTAX_ERROR"
        : "ERR_POSTGRES_SERVER_ERROR",
  };
  const severity = fields.get("V") ?? fields.get("S");

  if (severity !== undefined) {
    options["severity"] = severity;
  }

  for (const [code, name] of Object.entries(FIELDS)) {
    const value = fields.get(code);

    if (value !== undefined) {
      options[name] = value;
    }
  }

  return new SQL.PostgresError(
    fields.get("M") ?? "the server reported an error without a message",
    options as unknown as ConstructorParameters<typeof SQL.PostgresError>[1],
  );
}

/** The error for an authentication this client does not do. */
function unsupported(code: number): SQL.PostgresError {
  const method = (
    {
      2: "Kerberos V5",
      6: "SCM credentials",
      7: "GSSAPI",
      8: "GSSAPI",
      9: "SSPI",
    } as Readonly<Record<number, string>>
  )[code];

  return method === undefined
    ? new SQL.PostgresError(
        `the server asks for authentication by method ${code}, which Postgres's protocol does not have`,
        { code: "ERR_POSTGRES_UNKNOWN_AUTHENTICATION_METHOD" },
      )
    : new SQL.PostgresError(
        `the server asks for authentication by ${method}, which @tetsujs/sql does not support: it supports a password, MD5 and SCRAM-SHA-256`,
        { code: "ERR_POSTGRES_UNSUPPORTED_AUTHENTICATION_METHOD" },
      );
}

/** The error for a message the server should not have sent then. */
function unexpected(type: string): SQL.PostgresError {
  return new SQL.PostgresError(
    `the server sent a message of type ${JSON.stringify(type)}, which it should not have sent then`,
    { code: "ERR_POSTGRES_UNEXPECTED_MESSAGE" },
  );
}

/** The error for a message whose body is not as its type says. */
function malformed(): SQL.PostgresError {
  return new SQL.PostgresError(
    "the server sent a message whose body is not as its type says",
    { code: "ERR_POSTGRES_INVALID_MESSAGE" },
  );
}

/** A host as a socket takes it: an IPv6 address without its brackets. */
function unbracketed(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}
