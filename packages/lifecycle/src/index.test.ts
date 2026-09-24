/**
 * Tests for the shutdown sequence.
 *
 * The sequence is driven against stand-in servers, so every branch —
 * including the one where the platform never resolves — is reachable
 * without waiting on a real socket. The signal path runs in a child
 * process, because there is no other honest way to send a process
 * `SIGTERM` and watch it end.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { onShutdownSignals, shutdown } from "./index.ts";

/** A server whose `stop` behaves however a test needs it to. */
function stubServer(behaviour: {
  graceful?: number | "never";
  forced?: number | "never";
}) {
  const calls: string[] = [];

  const settle = (mode: number | "never" | undefined): Promise<void> => {
    if (mode === "never") {
      return new Promise<void>(() => {});
    }

    return Bun.sleep(mode ?? 0);
  };

  return {
    calls,
    stop: (force?: boolean) => {
      calls.push(force ? "stop(true)" : "stop()");

      return settle(force ? behaviour.forced : behaviour.graceful);
    },
  };
}

describe("the sequence", () => {
  test("waits for the server, then closes what it used", async () => {
    const server = stubServer({ graceful: 5 });
    const order: string[] = [];

    const result = await shutdown(server, {
      close: [
        () => {
          order.push("pool");
        },
        async () => {
          await Bun.sleep(1);

          order.push("queue");
        },
      ],
    });

    expect(server.calls).toEqual(["stop()"]);
    expect(order).toEqual(["pool", "queue"]);
    expect(result).toEqual({ forced: false, failures: [] });
  });

  test("closers run after the server stopped, never before", async () => {
    const server = stubServer({ graceful: 20 });
    const order: string[] = [];

    const stopping = shutdown(server, {
      close: [
        () => {
          order.push("closed");
        },
      ],
    });

    await Bun.sleep(5);

    expect(order).toEqual([]);

    await stopping;

    expect(order).toEqual(["closed"]);
  });

  test("forces the close when the grace period runs out", async () => {
    const server = stubServer({ graceful: "never", forced: 1 });

    const result = await shutdown(server, { graceMs: 10 });

    expect(server.calls).toEqual(["stop()", "stop(true)"]);
    expect(result.forced).toBe(true);
  });

  test("gives up on a forced close that never returns", async () => {
    const server = stubServer({ graceful: "never", forced: "never" });
    const started = Date.now();

    const result = await shutdown(server, { graceMs: 10, forceMs: 10 });

    expect(result.forced).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("a closer that throws does not stop the rest", async () => {
    const server = stubServer({ graceful: 1 });
    const order: string[] = [];

    const result = await shutdown(server, {
      close: [
        () => {
          throw new Error("pool refused");
        },
        () => {
          order.push("queue");
        },
      ],
    });

    expect(order).toEqual(["queue"]);
    expect((result.failures[0] as Error).message).toBe("pool refused");
  });
});

/**
 * Runs a script until it prints `listening`, then hands it to the test.
 *
 * `rest()` drains what the process printed after that, once it has ended.
 */
async function spawned(body: string) {
  const child = Bun.spawn(
    [
      "bun",
      "-e",
      `import { onShutdownSignals } from "${import.meta.dir}/index.ts";${body}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();

  let output = "";

  while (!output.includes("listening")) {
    const chunk = await reader.read();

    if (chunk.done) {
      break;
    }

    output += decoder.decode(chunk.value);
  }

  return {
    signal: () => child.kill("SIGTERM"),
    ended: async () => {
      const code = await child.exited;

      while (true) {
        const chunk = await reader.read();

        if (chunk.done) {
          break;
        }

        output += decoder.decode(chunk.value);
      }

      // Whatever the child complained about belongs in the failure message.
      return {
        code,
        output: output + (await new Response(child.stderr).text()),
      };
    },
  };
}

/** A server holding a socket open, so its `stop()` never resolves. */
const heldOpen = `
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      return new Response("ok");
    },
    websocket: { open() {}, message() {} },
  });
`;

describe("signals", () => {
  test("a handler is installed and can be taken off again", () => {
    const server = stubServer({ graceful: 1 });
    const before = process.listenerCount("SIGTERM");

    const { detach } = onShutdownSignals(server, { exit: false });

    expect(process.listenerCount("SIGTERM")).toBe(before + 1);

    detach();

    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  test("SIGTERM stops a real server and the process ends cleanly", async () => {
    const script = `
      import { onShutdownSignals } from "${import.meta.dir}/index.ts";

      const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });

      onShutdownSignals(server, {
        close: [() => console.log("pool closed")],
      });

      console.log("listening");
      setInterval(() => {}, 1000);
    `;

    const child = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();

    let output = "";

    while (!output.includes("listening")) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      output += decoder.decode(chunk.value);
    }

    child.kill("SIGTERM");

    const code = await child.exited;

    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      output += decoder.decode(chunk.value);
    }

    expect(output).toContain("pool closed");
    expect(code).toBe(0);
  });

  test("a closer that throws is printed when nobody receives it", async () => {
    const child = await spawned(`
      const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });

      onShutdownSignals(server, {
        close: [() => { throw new Error("pool refused"); }],
      });

      console.log("listening");
      setInterval(() => {}, 1000);
    `);

    child.signal();

    const { code, output } = await child.ended();

    expect(output).toContain("[tetsu] shutdown step failed:");
    expect(output).toContain("pool refused");
    expect(code).toBe(1);
  });

  test("a closer that throws goes to reportError instead", async () => {
    const child = await spawned(`
      const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });

      onShutdownSignals(server, {
        close: [() => { throw new Error("pool refused"); }],
        reportError: ({ source, error }) =>
          console.log("reported", source, error.message),
      });

      console.log("listening");
      setInterval(() => {}, 1000);
    `);

    child.signal();

    const { code, output } = await child.ended();

    expect(output).toContain("reported shutdown pool refused");
    expect(output).not.toContain("[tetsu] shutdown step failed:");
    expect(code).toBe(1);
  });

  test("a reportError that throws still leaves the failure printed", async () => {
    const child = await spawned(`
      const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });

      onShutdownSignals(server, {
        close: [() => { throw new Error("pool refused"); }],
        reportError: () => { throw new Error("logger gone"); },
      });

      console.log("listening");
      setInterval(() => {}, 1000);
    `);

    child.signal();

    const { output } = await child.ended();

    expect(output).toContain("[tetsu] reportError failed:");
    expect(output).toContain("logger gone");
    expect(output).toContain("pool refused");
  });

  test("a second signal stops waiting but still closes what was used", async () => {
    const child = await spawned(`
      ${heldOpen}
      onShutdownSignals(server, {
        graceMs: 5_000,
        close: [() => console.log("pool closed")],
      });

      const ws = new WebSocket("ws://localhost:" + server.port);

      ws.addEventListener("open", () => console.log("listening"));

      setInterval(() => {}, 1000);
    `);

    const started = Date.now();

    child.signal();

    await Bun.sleep(100);

    child.signal();

    const { code, output } = await child.ended();

    expect(output).toContain("pool closed");
    expect(code).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a third signal ends the process where it stands", async () => {
    const child = await spawned(`
      ${heldOpen}
      onShutdownSignals(server, {
        graceMs: 5_000,
        close: [
          () => {
            console.log("closer started");

            return new Promise(() => {});
          },
        ],
      });

      const ws = new WebSocket("ws://localhost:" + server.port);

      ws.addEventListener("open", () => console.log("listening"));

      setInterval(() => {}, 1000);
    `);

    child.signal();

    await Bun.sleep(100);

    child.signal();

    await Bun.sleep(300);

    child.signal();

    const { code, output } = await child.ended();

    expect(output).toContain("closer started");
    expect(code).toBe(1);
  });
});

describe("the pre-stop delay", () => {
  test("keeps serving before it drains, for as long as it was told", async () => {
    const stopped: number[] = [];
    const startedAt = Date.now();

    await shutdown(
      {
        stop: () => {
          stopped.push(Date.now() - startedAt);

          return Promise.resolve();
        },
      },
      { preStopDelayMs: 120 },
    );

    // The balancer has to hear about us before the socket closes, and it
    // hears through a readiness check that fails while this runs.
    expect(stopped[0]).toBeGreaterThanOrEqual(100);
  });

  test("is absent by default, because most callers have nobody to tell", async () => {
    const startedAt = Date.now();

    await shutdown({ stop: () => Promise.resolve() });

    expect(Date.now() - startedAt).toBeLessThan(50);
  });

  test("a second signal cuts it short, as it cuts the grace period short", async () => {
    const child = await spawned(`
      const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });

      onShutdownSignals(server, {
        preStopDelayMs: 5_000,
        close: [() => console.log("pool closed")],
      });

      console.log("listening");

      setInterval(() => {}, 1000);
    `);

    const startedAt = Date.now();

    child.signal();

    await Bun.sleep(80);

    child.signal();

    const { code, output } = await child.ended();

    // Waiting five seconds when the operator has said "now" twice is the
    // same mistake the grace period would make. The exit code is `1` for
    // the same reason it is on a cut-short grace period: the stop was not
    // clean, and an orchestrator reading the code should hear that.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(output).toContain("pool closed");
    expect(code).toBe(1);
  });
});

describe("the stopping signal", () => {
  test("is quiet until a stop is asked for", () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });

    const { stopping, detach } = onShutdownSignals(server, { exit: false });

    expect(stopping.aborted).toBe(false);

    detach();
    server.stop(true);
  });

  test("fires before the delay, so readiness can answer during it", async () => {
    const child = await spawned(`
      const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });

      const { stopping } = onShutdownSignals(server, {
        preStopDelayMs: 300,
        close: [() => console.log("pool closed")],
      });

      stopping.addEventListener("abort", () => console.log("not ready"));

      console.log("listening");

      setInterval(() => {}, 1000);
    `);

    child.signal();

    const { code, output } = await child.ended();

    // The order is the whole point: unready first, stop afterwards.
    expect(output.indexOf("not ready")).toBeLessThan(
      output.indexOf("pool closed"),
    );
    expect(output).toContain("not ready");
    expect(code).toBe(0);
  });
});
