/**
 * A session in a signed cookie.
 *
 * With a secret, the cookies `sign` names are sealed on the way out and
 * checked on the way in, with no call site mentioning it. A cookie whose
 * seal does not hold is left out, so `schema.cookies` reports it missing —
 * a forged session and no session look the same from outside.
 *
 * ```sh
 * bun examples/cookies.ts
 * curl -i -c jar -X POST localhost:3000/login -H 'content-type: application/json' \
 *   -d '{"name":"ada"}'                  # set-cookie: session=ada.<signature>
 * curl -b jar localhost:3000/me          # {"name":"ada"}
 * curl -b 'session=ada.forged' localhost:3000/me   # 422, cookies.session
 * curl -b jar -c jar -X POST localhost:3000/logout
 * ```
 *
 * @module
 */

import { createApp, route } from "@tetsujs/core";
import { z } from "zod";

const Login = z.object({ name: z.string().min(1) });

const Session = z.object({ session: z.string() });

const cookie = { httpOnly: true, sameSite: "lax", path: "/" } as const;

class SessionController {
  login = route({
    method: "POST",
    path: "/login",
    schema: { body: Login, response: { 204: null } },
    handler: (ctx) => {
      ctx.out.status = 204;
      ctx.out.cookies.set("session", ctx.body.name, {
        ...cookie,
        maxAge: 3600,
      });
    },
  });

  me = route({
    method: "GET",
    path: "/me",
    schema: { cookies: Session },
    handler: (ctx) => ({ name: ctx.cookies.session }),
  });

  logout = route({
    method: "POST",
    path: "/logout",
    schema: { response: { 204: null } },
    handler: (ctx) => {
      ctx.out.status = 204;
      ctx.out.cookies.delete("session", cookie);
    },
  });
}

export default createApp({
  cookies: {
    secret:
      Bun.env.COOKIE_SECRET ?? "an example secret, never this in production",
    sign: ["session"],
  },
  routes: new SessionController(),
});
