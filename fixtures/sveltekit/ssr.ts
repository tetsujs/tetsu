/**
 * The fixture rendered on the server, as a user's app is: the contract's
 * application on the port the client points at, the app in Vite's dev
 * server, and each page whose `load` calls the client with SvelteKit's
 * `fetch` requested — it must answer `200` with the user in its HTML.
 *
 * Type-checking cannot see this: SvelteKit refuses, while it renders, a
 * response header its `filterSerializedResponseHeaders` does not allow,
 * and the client reads `content-type`.
 *
 * The application answers through a proxy that adds the CORS header
 * SvelteKit's `fetch` asks of another origin on the server too.
 *
 * @module
 */

import { app } from "../../packages/client/test-utils/contract-app.ts";

const PAGES = ["/", "/query"];
const VITE = "http://localhost:5173";

const application = Bun.serve({ ...app, port: 0 });
const api = Bun.serve({
  port: 3000,
  fetch: async (request) => {
    const url = new URL(request.url);

    url.port = String(application.port);

    const response = await fetch(new Request(url, request));
    const headers = new Headers(response.headers);

    headers.set("access-control-allow-origin", "*");

    return new Response(response.body, { status: response.status, headers });
  },
});
const vite = Bun.spawn(
  ["node_modules/.bin/vite", "dev", "--port", "5173", "--strictPort"],
  { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
);

let failed = false;

try {
  await ready();

  for (const page of PAGES) {
    const response = await fetch(`${VITE}${page}`);
    const html = await response.text();

    if (response.status !== 200 || !html.includes("Ada")) {
      failed = true;
      console.error(`${page}: ${response.status}, the user is not in the page`);
    } else {
      console.log(`${page}: 200, the user is in the page`);
    }
  }
} finally {
  vite.kill();
  await vite.exited;
  api.stop(true);
  application.stop(true);
}

if (failed) {
  console.error(await new Response(vite.stderr).text());
  console.error(await new Response(vite.stdout).text());
  process.exit(1);
}

/** Waits for Vite to answer, for a minute at most. */
async function ready(): Promise<void> {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    try {
      await fetch(VITE);

      return;
    } catch {
      await Bun.sleep(250);
    }
  }

  throw new Error("Vite did not start");
}
