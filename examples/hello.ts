/**
 * The smallest application: a controller with one route.
 *
 * A controller is a class whose fields are routes; `createApp` collects
 * them. The default export is served by Bun as it is.
 *
 * ```sh
 * bun examples/hello.ts
 * curl localhost:3000/hello/ada        # {"hello":"ada"}
 * ```
 *
 * @module
 */

import { createApp, route } from "@tetsujs/core";

class HelloController {
  greet = route({
    method: "GET",
    path: "/hello/:name",
    handler: (ctx) => ({ hello: ctx.params.name }),
  });
}

export default createApp({ routes: new HelloController() });
