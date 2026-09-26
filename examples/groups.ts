/**
 * Topology: prefixes, zone-wide guards, and hook packages mounted by slot.
 *
 * Every package is one hook, made once and mounted by name in the slot it
 * runs in, beside the application's own. CORS belongs on the application
 * rather than a group, because a group's hooks do not run on the `OPTIONS`
 * preflight — no route of the group answered it — and before every hook
 * that can refuse, so that a refusal still carries its headers.
 * `requestId()` never refuses, so it goes before `cors()`, and a preflight
 * carries its `x-request-id` too.
 *
 * A group hook may guard, but what it contributes does not reach the
 * handlers' types: a route that reads a field mounts the hook itself. The
 * rate limit here is on the one route that needs it.
 *
 * ```sh
 * bun examples/groups.ts
 * curl -i localhost:3000/api/status              # x-request-id, security headers
 * curl -i -X OPTIONS localhost:3000/api/status \
 *   -H 'origin: http://localhost:5173' -H 'access-control-request-method: GET'
 * curl localhost:3000/api/admin/stats            # 403
 * curl -H 'x-role: admin' localhost:3000/api/admin/stats
 * for i in 1 2 3 4; do curl -s -o /dev/null -w '%{http_code} ' \
 *   -X POST localhost:3000/api/feedback; done    # 202 202 202 429
 * ```
 *
 * @module
 */

import {
  controller,
  createApp,
  group,
  HttpError,
  hook,
  route,
} from "@tetsujs/core";
import { cors } from "@tetsujs/cors";
import { rateLimit } from "@tetsujs/rate-limit";
import { requestId } from "@tetsujs/request-id";
import { accessLog } from "@tetsujs/request-log";
import { secureHeaders } from "@tetsujs/secure-headers";

const adminOnly = hook.beforeParse((ctx) => {
  if (ctx.req.headers.get("x-role") !== "admin") {
    throw new HttpError(403);
  }
});

const limit = rateLimit({
  limit: 3,
  windowMs: 60_000,
  key: (ctx) => ctx.server.requestIP(ctx.req)?.address,
});

const browser = cors({ origin: "http://localhost:5173" });
const id = requestId();
const log = accessLog();
const secure = secureHeaders();

const statusController = controller("Status", () => ({
  status: route({
    method: "GET",
    path: "/status",
    handler: () => ({ ok: true }),
  }),

  feedback: route({
    method: "POST",
    path: "/feedback",
    hooks: { beforeParse: [limit] },
    handler: (ctx) => {
      ctx.out.status = 202;

      return { accepted: true };
    },
  }),
}));

const adminController = controller("Admin", () => ({
  stats: route({
    method: "GET",
    path: "/stats",
    handler: () => ({ users: 42 }),
  }),
}));

export default createApp({
  hooks: {
    beforeParse: [id, browser],
    beforeResponse: [secure],
    afterResponse: [log],
  },
  routes: group("/api", {
    children: [
      statusController(),
      group("/admin", {
        hooks: { beforeParse: [adminOnly] },
        children: [adminController()],
      }),
    ],
  }),
});
