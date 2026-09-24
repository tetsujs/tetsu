/**
 * Integration tests: failures no response can carry, through a live
 * server, into the application's `reportError`.
 *
 * One report per source the core produces, what each carries, that the
 * failures an application answers itself are not reported, and that a
 * receiver which fails in turn does not take the failure with it.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { testCtx } from "../test-utils/ctx.ts";
import { captureErrors } from "../test-utils/logs.ts";
import { serve } from "../test-utils/server.ts";
import { connect } from "../test-utils/socket.ts";
import { createApp } from "./app.ts";
import { HttpError } from "./error.ts";
import { hook } from "./hook.ts";
import type { FailureReport } from "./report.ts";
import { ResponseContractError, reportFailure } from "./report.ts";
import { route } from "./route.ts";
import type { StandardSchemaV1 } from "./schema.ts";
import { ws } from "./ws.ts";

const Named: StandardSchemaV1<unknown, { name: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof (value as { name?: unknown }).name === "string"
        ? { value: value as { name: string } }
        : { issues: [{ message: "name must be a string", path: ["name"] }] },
  },
};

const stamp = hook.beforeParse(() => ({ requestId: "req-1" }));

class FailingController {
  unhandled = route({
    method: "GET",
    path: "/unhandled",
    handler: () => {
      throw new Error("database went away");
    },
  });

  refused = route({
    method: "GET",
    path: "/refused",
    handler: () => {
      throw new HttpError(409);
    },
  });

  undeclared = route({
    method: "POST",
    path: "/undeclared",
    schema: { response: { 201: Named } },
    handler: () => ({ name: "n" }) as never,
  });

  malformed = route({
    method: "GET",
    path: "/malformed",
    schema: { response: Named },
    handler: () => ({ name: 42 }) as never,
  });

  observed = route({
    method: "GET",
    path: "/observed",
    hooks: {
      afterResponse: [
        hook.afterResponse(() => {
          throw new Error("metrics down");
        }),
      ],
    },
    handler: () => ({ ok: true }),
  });

  observedLater = route({
    method: "GET",
    path: "/observed-later",
    hooks: {
      afterResponse: [
        hook.afterResponse(async () => {
          throw new Error("shipper down");
        }),
      ],
    },
    handler: () => ({ ok: true }),
  });

  mapperFails = route({
    method: "GET",
    path: "/mapper-fails",
    hooks: {
      onError: [
        hook.onError(() => {
          throw new Error("mapper broke");
        }),
      ],
    },
    handler: () => {
      throw new HttpError(404);
    },
  });

  mapped = route({
    method: "GET",
    path: "/mapped",
    hooks: {
      onError: [hook.onError(() => new Response("mapped", { status: 503 }))],
    },
    handler: () => {
      throw new Error("the hook takes this one");
    },
  });

  errorPathFails = route({
    method: "GET",
    path: "/error-path-fails",
    hooks: {
      beforeResponse: [
        hook.beforeResponse(() => {
          throw new Error("decorator broke");
        }),
      ],
    },
    handler: () => {
      throw new HttpError(400);
    },
  });

  reported = route({
    method: "GET",
    path: "/reported",
    handler: (ctx) => {
      reportFailure(ctx, "custom", new Error("a package's own"));

      return { ok: true };
    },
  });

  socket = ws({
    path: "/socket",
    open: (socket) => {
      socket.send("ready");

      throw new Error("handler exploded");
    },
  });
}

/** The message of a report's error, when there is a report. */
function messageOf(report: FailureReport<object> | undefined) {
  return (report?.error as Error | undefined)?.message;
}

/** Waits for a report that arrives after the response, as observers do. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await Bun.sleep(5);
  }
}

describe("reportError", () => {
  const errors = captureErrors();
  const reports: FailureReport<object>[] = [];

  const request = serve(
    createApp({
      hooks: { beforeParse: [stamp] },
      reportError: (report) => {
        reports.push(report);
      },
      routes: new FailingController(),
    }),
  );

  const reported = async (path: string, init?: RequestInit) => {
    reports.length = 0;

    const res = await request(path, init);

    return { res, reports };
  };

  test("receives an error no hook answered, with the request's context", async () => {
    const { res } = await reported("/unhandled");

    expect(res.status).toBe(500);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.source).toBe("unhandled");
    expect(messageOf(reports[0])).toBe("database went away");
    expect(reports[0]?.ctx).toMatchObject({
      requestId: "req-1",
      route: { path: "/unhandled" },
    });
    expect(errors.lines).toEqual([]);
  });

  test("hears nothing of an HttpError, which is an answer", async () => {
    const { res } = await reported("/refused");

    expect(res.status).toBe(409);
    expect(reports).toEqual([]);
  });

  test("hears nothing of an error an onError hook answered", async () => {
    const { res } = await reported("/mapped");

    expect(res.status).toBe(503);
    expect(reports).toEqual([]);
  });

  test("receives a status the response map does not declare as a broken contract", async () => {
    const { res } = await reported("/undeclared", { method: "POST" });

    expect(res.status).toBe(500);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.source).toBe("response");
    expect(reports[0]?.error).toBeInstanceOf(ResponseContractError);
    expect(messageOf(reports[0])).toContain(
      "Handler answered 200, which its response map does not declare (201)",
    );
  });

  test("receives a body its schema rejects, with the issues kept apart", async () => {
    const { res } = await reported("/malformed");

    expect(res.status).toBe(500);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.source).toBe("response");

    const error = reports[0]?.error as ResponseContractError;

    expect(error.message).toBe(
      "Handler result does not match its response schema",
    );
    expect(error.issues).toEqual([
      { message: "name must be a string", path: ["name"] },
    ]);
  });

  test("receives an observer that threw after the response went", async () => {
    const { res } = await reported("/observed");

    expect(res.status).toBe(200);

    await until(() => reports.length > 0);

    expect(reports[0]?.source).toBe("afterResponse");
    expect(messageOf(reports[0])).toBe("metrics down");
    expect(reports[0]?.ctx).toMatchObject({ requestId: "req-1" });
  });

  test("receives an asynchronous observer that rejected", async () => {
    await reported("/observed-later");

    await until(() => reports.length > 0);

    expect(reports[0]?.source).toBe("afterResponse");
    expect(messageOf(reports[0])).toBe("shipper down");
  });

  test("receives an onError hook that threw, and the request is still answered", async () => {
    const { res } = await reported("/mapper-fails");

    expect(res.status).toBe(404);
    expect(reports.map((report) => report.source)).toEqual(["onError"]);
    expect(messageOf(reports[0])).toBe("mapper broke");
  });

  test("receives an error path that failed in turn", async () => {
    const { res } = await reported("/error-path-fails");

    expect(res.status).toBe(500);

    const failed = reports.find((report) => report.source === "errorResponse");

    expect(messageOf(failed)).toBe("decorator broke");
  });

  test("receives what a package reports through reportFailure", async () => {
    const { res } = await reported("/reported");

    expect(res.status).toBe(200);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.source).toBe("custom");
    expect(reports[0]?.ctx).toMatchObject({ requestId: "req-1" });
  });

  test("receives a WebSocket handler that threw, with no context", async () => {
    reports.length = 0;

    const socket = await connect(request, "/socket");

    expect(await socket.next()).toBe("ready");

    await until(() => reports.length > 0);

    expect(reports[0]?.source).toBe("websocket");
    expect(messageOf(reports[0])).toBe("handler exploded");
    expect(reports[0]?.ctx).toBeUndefined();

    socket.close();
  });
});

describe("a receiver that fails", () => {
  const errors = captureErrors();

  const throwing = serve(
    createApp({
      reportError: () => {
        throw new Error("logger gone");
      },
      routes: new FailingController(),
    }),
  );

  const rejecting = serve(
    createApp({
      reportError: async () => {
        throw new Error("shipper gone");
      },
      routes: new FailingController(),
    }),
  );

  test("is printed together with the failure it was handed", async () => {
    const res = await throwing("/unhandled");

    expect(res.status).toBe(500);

    const printed = errors.lines.join("\n");

    expect(printed).toContain("[tetsu] reportError failed: Error: logger gone");
    expect(printed).toContain(
      "[tetsu] Unhandled error: Error: database went away",
    );
  });

  test("is printed when it rejects, too", async () => {
    await rejecting("/unhandled");

    await until(() => errors.lines.length >= 2);

    const printed = errors.lines.join("\n");

    expect(printed).toContain(
      "[tetsu] reportError failed: Error: shipper gone",
    );
    expect(printed).toContain("database went away");
  });
});

describe("without a receiver", () => {
  const errors = captureErrors();

  const request = serve(createApp({ routes: new FailingController() }));

  test("a failure is printed as before", async () => {
    await request("/unhandled");

    expect(errors.lines.join("\n")).toContain(
      "[tetsu] Unhandled error: Error: database went away",
    );
  });

  test("a package's report is printed under its source", async () => {
    await request("/reported");

    expect(errors.lines.join("\n")).toContain(
      "[tetsu] custom: Error: a package's own",
    );
  });

  test("a context built outside a request prints its report", () => {
    reportFailure(testCtx({}), "stream", new Error("unit-tested"));

    expect(errors.lines).toEqual(["[tetsu] stream failed: Error: unit-tested"]);
  });
});
