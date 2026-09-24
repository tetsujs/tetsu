/**
 * Type-level tests for the context a failure report carries.
 *
 * `createApp` knows its own hooks, so `reportError` sees what they
 * contribute — optional, since a failure can precede the hook — and
 * nothing that no hook of the application contributes.
 *
 * @module
 */

import type { Equal } from "../test-utils/types.ts";
import { createApp } from "./app.ts";
import type { BaseCtx } from "./context.ts";
import { hook } from "./hook.ts";
import type { FailureReport, FailureSource, ReportError } from "./report.ts";
import { reportFailure } from "./report.ts";

const stamp = hook.beforeParse(() => ({ requestId: "r" }));
const clock = hook.beforeParse(() => ({ startedAt: 0 }));
const tenant = hook.beforeHandle(() => ({ tenant: { id: 1 } }));
const cleanup = hook.afterResponse(() => {});

declare function exact<T extends true>(): void;

createApp({
  hooks: { beforeParse: [stamp] },
  reportError: ({ ctx }) => {
    exact<
      Equal<typeof ctx, undefined | (BaseCtx & Partial<{ requestId: string }>)>
    >();

    const id: string | undefined = ctx?.requestId;

    // @ts-expect-error — optional: the failure may have come before the hook
    const sure: string = ctx?.requestId;

    // @ts-expect-error — no hook of this application contributes it
    ctx?.user;

    void [id, sure];
  },
  routes: [],
});

createApp({
  hooks: [
    { beforeParse: [stamp] },
    { beforeParse: [clock], afterResponse: [cleanup] },
    { beforeHandle: [tenant] },
  ],
  reportError: ({ ctx }) => {
    const id: string | undefined = ctx?.requestId;
    const started: number | undefined = ctx?.startedAt;
    const tenantId: number | undefined = ctx?.tenant?.id;

    // @ts-expect-error — still nothing beyond what the hooks contribute
    ctx?.user;

    void [id, started, tenantId];
  },
  routes: [],
});

createApp({
  reportError: ({ ctx, source, error }) => {
    exact<Equal<typeof ctx, BaseCtx | undefined>>();
    exact<Equal<typeof source, FailureSource>>();
    exact<Equal<typeof error, unknown>>();

    // @ts-expect-error — a field no hook contributes
    ctx?.requestId;
  },
  routes: [],
});

const shared: ReportError = (report: FailureReport) => {
  void report;
};

createApp({ hooks: { beforeParse: [stamp] }, reportError: shared, routes: [] });
createApp({ reportError: shared, routes: [] });

createApp({ reportError: async () => {}, routes: [] });

reportFailure({} as BaseCtx, "stream", new Error("e"));
reportFailure({} as BaseCtx, "my-package", new Error("e"));

// @ts-expect-error — a context is required, not only the source
reportFailure("stream", new Error("e"));
