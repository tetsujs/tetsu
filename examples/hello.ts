/**
 * The smallest application: a controller with one route.
 *
 * A controller is a name and a function returning its routes; `createApp`
 * collects them. The default export is served by Bun as it is.
 *
 * ```sh
 * bun examples/hello.ts
 * curl localhost:3000/hello/ada        # {"hello":"ada"}
 * ```
 *
 * @module
 */

import { controller, createApp, route } from "@tetsujs/core";

const helloController = controller("Hello", () => ({
  greet: route({
    method: "GET",
    path: "/hello/:name",
    handler: (ctx) => ({ hello: ctx.params.name }),
  }),
}));

export default createApp({ routes: helloController() });
