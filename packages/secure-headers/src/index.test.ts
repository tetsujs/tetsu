/**
 * Tests for the security headers hook.
 *
 * Header values are a contract with a browser, so they are read off real
 * responses rather than off the factory: what matters is that they reach
 * every outcome, including the ones no handler produced.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { createApp, HttpError, hook, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import { apiPolicy, secureHeaders } from "./index.ts";

const refuse = hook.beforeParse(() => new Response("no", { status: 429 }));

class Controller {
  ok = route({
    method: "GET",
    path: "/ok",
    handler: () => ({ ok: true }),
  });

  fails = route({
    method: "GET",
    path: "/fails",
    handler: () => {
      throw new HttpError(418, { code: "teapot" });
    },
  });

  refused = route({
    method: "GET",
    path: "/refused",
    hooks: { beforeParse: [refuse] },
    handler: () => ({ unreachable: true }),
  });
}

const secure = secureHeaders();

const request = serve(
  createApp({
    hooks: { beforeResponse: [...secure.beforeResponse] },
    routes: new Controller(),
  }),
);

describe("the four that are on without being asked", () => {
  test("are on an ordinary response", async () => {
    const res = await request("/ok");

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=15552000",
    );
  });

  test("do not include a policy nobody asked for", async () => {
    const res = await request("/ok");

    expect(res.headers.get("content-security-policy")).toBeNull();
  });
});

describe("every outcome carries them", () => {
  test("an error mapped by the framework", async () => {
    const res = await request("/fails");

    expect(res.status).toBe(418);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  test("a refusal short-circuited out of beforeParse", async () => {
    const res = await request("/refused");

    // The response never reached a handler, and this is the one an
    // attacker is iterating over.
    expect(res.status).toBe(429);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("a 404 no route ever saw", async () => {
    const res = await request("/nothing-here");

    expect(res.status).toBe(404);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("what the options change", () => {
  test("each header can be left off on its own", async () => {
    const bare = serve(
      createApp({
        hooks: {
          beforeResponse: [
            ...secureHeaders({
              hsts: false,
              frameOptions: false,
              referrerPolicy: false,
              noSniff: false,
            }).beforeResponse,
          ],
        },
        routes: new Controller(),
      }),
    );

    const res = await bare("/ok");

    expect(res.headers.get("x-content-type-options")).toBeNull();
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("referrer-policy")).toBeNull();
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  test("the policy is written when one is given", async () => {
    const strict = serve(
      createApp({
        hooks: {
          beforeResponse: [
            ...secureHeaders({ contentSecurityPolicy: apiPolicy })
              .beforeResponse,
          ],
        },
        routes: new Controller(),
      }),
    );

    const res = await strict("/ok");

    expect(res.headers.get("content-security-policy")).toBe(apiPolicy);
  });

  test("hsts carries what it was told to", async () => {
    const strict = serve(
      createApp({
        hooks: {
          beforeResponse: [
            ...secureHeaders({
              hsts: { maxAge: 63_072_000, includeSubDomains: true },
            }).beforeResponse,
          ],
        },
        routes: new Controller(),
      }),
    );

    const res = await strict("/ok");

    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains",
    );
  });
});

describe("the combination the preload list would drop", () => {
  test("preload without includeSubDomains is refused here, not there", () => {
    expect(() =>
      secureHeaders({ hsts: { preload: true, maxAge: 63_072_000 } }),
    ).toThrow(/includeSubDomains/);
  });

  test("preload under a year is refused too", () => {
    expect(() =>
      secureHeaders({
        hsts: { preload: true, includeSubDomains: true, maxAge: 86_400 },
      }),
    ).toThrow(/at least 31536000/);
  });

  test("exactly a year is enough, a second less is not", () => {
    const preload = (maxAge: number) => () =>
      secureHeaders({
        hsts: { preload: true, includeSubDomains: true, maxAge },
      });

    expect(preload(31_536_000)).not.toThrow();
    expect(preload(31_535_999)).toThrow(/at least 31536000/);
  });

  test("a complete one is accepted", async () => {
    const preloading = serve(
      createApp({
        hooks: {
          beforeResponse: [
            ...secureHeaders({
              hsts: {
                preload: true,
                includeSubDomains: true,
                maxAge: 63_072_000,
              },
            }).beforeResponse,
          ],
        },
        routes: new Controller(),
      }),
    );

    const res = await preloading("/ok");

    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
  });
});

describe("one route that needs an exception", () => {
  const allowFraming = hook.beforeResponse((ctx) => {
    ctx.out.headers.set("x-frame-options", "SAMEORIGIN");
  });

  const mixed = serve(
    createApp({
      hooks: { beforeResponse: [...secure.beforeResponse] },
      routes: {
        framed: route({
          method: "GET",
          path: "/framed",
          hooks: { beforeResponse: [allowFraming] },
          handler: () => ({ ok: true }),
        }),
        written: route({
          method: "GET",
          path: "/written",
          handler: (ctx) => {
            ctx.out.headers.set("x-frame-options", "SAMEORIGIN");

            return { ok: true };
          },
        }),
        plain: route({
          method: "GET",
          path: "/plain",
          handler: () => ({ ok: true }),
        }),
      },
    }),
  );

  test("declares it as a hook on the route, and wins", async () => {
    // Route chains run after the application's, so the exception is
    // declared where a reader of that route will see it.
    expect((await mixed("/framed")).headers.get("x-frame-options")).toBe(
      "SAMEORIGIN",
    );
  });

  test("cannot do it from the handler, which runs earlier", async () => {
    expect((await mixed("/written")).headers.get("x-frame-options")).toBe(
      "DENY",
    );
  });

  test("leaves every other route alone", async () => {
    expect((await mixed("/plain")).headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("one path that serves a document", () => {
  // The recipe the README gives for an application that mounts a policy
  // application-wide and still serves HTML somewhere — a documentation
  // page, a health dashboard. The exemption is keyed on `ctx.route`, so it
  // names the endpoint rather than matching the URL that arrived.
  const exempt = hook.beforeResponse((ctx) => {
    if (ctx.route?.path === "/page") {
      ctx.out.headers.delete("content-security-policy");
    }
  });

  const mixed = serve(
    createApp({
      hooks: {
        beforeResponse: [
          ...secureHeaders({ contentSecurityPolicy: apiPolicy }).beforeResponse,
          exempt,
        ],
      },
      routes: {
        page: route({
          method: "GET",
          path: "/page",
          handler: () =>
            new Response("<h1>hi</h1>", {
              headers: { "content-type": "text/html" },
            }),
        }),
        data: route({
          method: "GET",
          path: "/data",
          handler: () => ({ ok: true }),
        }),
      },
    }),
  );

  test("can be let out of the policy", async () => {
    const res = await mixed("/page");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  test("without letting anything else out", async () => {
    const res = await mixed("/data");

    expect(res.headers.get("content-security-policy")).toBe(apiPolicy);
  });

  test("and the rest of the headers stay on it regardless", async () => {
    const res = await mixed("/page");

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
