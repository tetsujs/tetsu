/**
 * Test helper: a server that speaks Postgres's protocol as a test scripts
 * it, to hold a client to what a real server does not do on demand —
 * another way to authenticate, a forged proof, a connection cut halfway,
 * a message split across packets.
 *
 * Each connection runs the script. What a script throws, such as a failed
 * expectation, `stop()` throws again, so a script ends once it has sent
 * what the test is about, rather than wait on a client that hangs up.
 *
 * ```ts
 * const stub = await stubServer(async (peer) => {
 *   await peer.untyped();
 *   peer.send(authentication(0), READY);
 * });
 *
 * try {
 *   const wire = await Wire.connect(new SQL(stub.url()));
 *   // ...
 * } finally {
 *   await stub.stop();
 * }
 * ```
 *
 * @module
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo, Socket } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { TLSSocket } from "node:tls";

/** A message of the client's: its type, and its body. */
export interface Received {
  readonly type: string;
  readonly body: Buffer;
}

/** The server's side of a client's connection. */
export interface Peer {
  /**
   * The body of the next message without a type: a startup message, or a
   * request for TLS.
   */
  untyped(): Promise<Buffer>;

  /** The next message with a type. */
  message(): Promise<Received>;

  /** Sends each of `bytes` as it is. */
  send(...bytes: Uint8Array[]): void;

  /**
   * Starts TLS on the connection, as its server, with `credentials`: a
   * {@link certificate} no authority signed, by default.
   */
  secure(credentials?: Credentials): void;

  /**
   * The name the client asked TLS for, as SNI, once TLS has started; none
   * when it asked for none.
   */
  readonly servername: string | undefined;

  /** Whether the client has closed the connection. */
  readonly closed: boolean;

  /** Closes the connection. */
  close(): void;
}

/** A stub server, listening. */
export interface Stub {
  /**
   * A URL of it, as the user `tetsu` with the password `secret`, of the
   * database `app`, with `query` as its parameters.
   */
  url(query?: string): string;

  /** Closes the connections and the server, and throws what a script threw. */
  stop(): Promise<void>;
}

/** A key, and a certificate of it, for `localhost`. */
export interface Credentials {
  readonly key: string;
  readonly cert: string;
}

/** An authority of the tests' own, and a server's credentials it signed. */
export interface Authority {
  /** The authority's certificate, for a client to trust. */
  readonly ca: string;

  /** A key, and a certificate of it the authority signed, for `localhost`. */
  readonly server: Credentials;
}

/** Ready for a query, out of a transaction. */
export const READY = backend("Z", Buffer.from("I"));

let credentials: Credentials | undefined;

let signed: Authority | undefined;

/** Listens on a port of its own, and runs `script` for each connection. */
export async function stubServer(
  script: (peer: Peer) => Promise<void>,
): Promise<Stub> {
  const failures: unknown[] = [];
  const peers: Connection[] = [];
  const server = createServer((socket) => {
    const peer = new Connection(socket);

    peers.push(peer);
    script(peer).catch((error: unknown) => {
      failures.push(error);
      peer.close();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address() as AddressInfo;

  return {
    url(query = "") {
      return `postgres://tetsu:secret@127.0.0.1:${port}/app${query === "" ? "" : `?${query}`}`;
    },
    async stop() {
      for (const peer of peers) {
        peer.close();
      }

      await new Promise((resolve) => {
        server.close(resolve);
      });

      if (failures.length > 0) {
        throw failures[0];
      }
    },
  };
}

/** A message of the server's: its type, its length, then `body`. */
export function backend(type: string, ...body: Uint8Array[]): Buffer {
  const content = Buffer.concat(body);
  const head = Buffer.alloc(5);

  head.write(type, 0, "latin1");
  head.writeInt32BE(content.length + 4, 1);

  return Buffer.concat([head, content]);
}

/** An authentication request of the server's: its code, then `body`. */
export function authentication(code: number, ...body: Uint8Array[]): Buffer {
  return backend("R", int32(code), ...body);
}

/** An error of the server's, of the fields by their codes, such as `C`. */
export function errorResponse(
  fields: Readonly<Record<string, string>>,
): Buffer {
  return backend(
    "E",
    ...Object.entries(fields).map(([code, value]) =>
      cstring(`${code}${value}`),
    ),
    Buffer.from([0]),
  );
}

/** A string ended by a NUL. */
export function cstring(text: string): Buffer {
  return Buffer.from(`${text}\0`);
}

export function int16(value: number): Buffer {
  const bytes = Buffer.alloc(2);

  bytes.writeInt16BE(value);

  return bytes;
}

export function int32(value: number): Buffer {
  const bytes = Buffer.alloc(4);

  bytes.writeInt32BE(value);

  return bytes;
}

/** The version and the parameters of a startup message's body. */
export function startupOf(body: Buffer): {
  readonly version: number;
  readonly parameters: readonly (readonly [string, string])[];
} {
  const strings = body.subarray(4).toString().split("\0");
  const parameters: [string, string][] = [];

  for (let index = 0; strings[index] !== ""; index += 2) {
    parameters.push([strings[index] as string, strings[index + 1] as string]);
  }

  return { version: body.readInt32BE(0), parameters };
}

/**
 * A key and a certificate for `localhost` that no authority signed, which
 * `openssl` makes once a run.
 */
export function certificate(): Credentials {
  if (credentials === undefined) {
    const dir = mkdtempSync(join(tmpdir(), "tetsu-sql-tls-"));

    try {
      const made = Bun.spawnSync(
        [
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          join(dir, "key.pem"),
          "-out",
          join(dir, "cert.pem"),
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost",
        ],
        { stdout: "ignore", stderr: "pipe" },
      );

      if (made.exitCode !== 0) {
        throw new Error(
          `the tests of TLS need openssl, which could not make a certificate: ${made.stderr.toString()}`,
        );
      }

      credentials = {
        key: readFileSync(join(dir, "key.pem"), "utf8"),
        cert: readFileSync(join(dir, "cert.pem"), "utf8"),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return credentials;
}

/**
 * An authority of the tests' own, and credentials it signed for
 * `localhost`, which `openssl` makes once a run: a test that trusts the
 * authority holds a client to a certificate's name.
 */
export function authority(): Authority {
  if (signed === undefined) {
    const dir = mkdtempSync(join(tmpdir(), "tetsu-sql-tls-"));
    const at = (name: string) => join(dir, name);
    const run = (...args: string[]) => {
      const made = Bun.spawnSync(["openssl", ...args], {
        stdout: "ignore",
        stderr: "pipe",
      });

      if (made.exitCode !== 0) {
        throw new Error(
          `the tests of TLS need openssl, which could not make a certificate: ${made.stderr.toString()}`,
        );
      }
    };

    try {
      writeFileSync(
        at("openssl.cnf"),
        [
          "[req]",
          "distinguished_name = name",
          "[name]",
          "[authority]",
          "basicConstraints = critical, CA:TRUE",
          "keyUsage = critical, keyCertSign, cRLSign",
          "subjectKeyIdentifier = hash",
          "[server]",
          "subjectAltName = DNS:localhost",
          "",
        ].join("\n"),
      );
      run(
        ...["req", "-x509", "-config", at("openssl.cnf")],
        ...["-extensions", "authority", "-subj", "/CN=tetsu-sql-authority"],
        ...["-newkey", "rsa:2048", "-nodes", "-days", "1"],
        ...["-keyout", at("ca.key"), "-out", at("ca.pem")],
      );
      run(
        ...["req", "-new", "-config", at("openssl.cnf")],
        ...["-subj", "/CN=tetsu-sql-server", "-newkey", "rsa:2048", "-nodes"],
        ...["-keyout", at("server.key"), "-out", at("server.csr")],
      );
      run(
        ...["x509", "-req", "-in", at("server.csr"), "-days", "1"],
        ...["-CA", at("ca.pem"), "-CAkey", at("ca.key"), "-set_serial", "2"],
        ...["-extfile", at("openssl.cnf"), "-extensions", "server"],
        ...["-out", at("server.pem")],
      );
      signed = {
        ca: readFileSync(at("ca.pem"), "utf8"),
        server: {
          key: readFileSync(at("server.key"), "utf8"),
          cert: readFileSync(at("server.pem"), "utf8"),
        },
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return signed;
}

/** A client's connection, read as the messages a script asks for. */
class Connection implements Peer {
  closed = false;

  servername: string | undefined;

  private stream: Duplex;

  /** What has come in that no script has read yet. */
  private pending = Buffer.alloc(0);

  /** Wakes a read that waits for more to come in. */
  private wake: (() => void) | undefined;

  constructor(socket: Socket) {
    this.stream = socket;
    this.listen(socket);
  }

  async untyped(): Promise<Buffer> {
    const length = (await this.bytes(4)).readInt32BE(0);

    return await this.bytes(length - 4);
  }

  async message(): Promise<Received> {
    const head = await this.bytes(5);

    return {
      type: String.fromCharCode(head[0] as number),
      body: await this.bytes(head.readInt32BE(1) - 4),
    };
  }

  send(...bytes: Uint8Array[]): void {
    for (const chunk of bytes) {
      this.stream.write(chunk);
    }
  }

  secure(credentials: Credentials = certificate()): void {
    const raw = this.stream;

    raw.removeAllListeners("data");
    raw.removeAllListeners("close");

    const secure = new TLSSocket(raw as Socket, {
      isServer: true,
      ...credentials,
    });

    secure.once("secure", () => {
      const { servername } = secure as TLSSocket & { servername?: unknown };

      this.servername = typeof servername === "string" ? servername : undefined;
    });
    this.stream = secure;
    this.listen(secure);
  }

  close(): void {
    this.stream.destroy();
  }

  private listen(stream: Duplex): void {
    stream.on("data", (chunk: Buffer) => {
      this.pending = Buffer.concat([this.pending, chunk]);
      this.wake?.();
    });
    stream.on("close", () => {
      this.closed = true;
      this.wake?.();
    });
    stream.on("error", cut);
  }

  /** The next `length` bytes, once they have come in. */
  private async bytes(length: number): Promise<Buffer> {
    while (this.pending.length < length) {
      if (this.closed) {
        throw new Error("the client closed the connection");
      }

      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }

    const bytes = this.pending.subarray(0, length);

    this.pending = this.pending.subarray(length);

    return bytes;
  }
}

/** Takes an error of a connection the client cut, which `closed` says. */
function cut(): void {}
