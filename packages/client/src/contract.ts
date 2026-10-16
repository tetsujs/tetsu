/**
 * The contract of an application, for a script of one's own — what the
 * `tetsu-client contract` command writes, as text.
 *
 * ```ts
 * import { generateContract } from "@tetsujs/client/contract";
 *
 * const contract = await generateContract({ entry: "src/app.ts" });
 *
 * await Bun.write("../web/src/api.contract.d.ts", contract);
 * ```
 *
 * The contract is a `.d.ts` of plain types: every route of the
 * application, what a call of it sends and each response as the client
 * receives it — without the server's code, its validators or Bun. A
 * frontend creates its client with it as it would with `typeof app`:
 *
 * ```ts
 * import type { Api } from "./api.contract";
 *
 * const api = createClient<Api>({ baseUrl: "https://api.example.com" });
 * ```
 *
 * It is worked out by TypeScript 6.0.3, which Bun installs into its cache
 * on first use, in a process of its own. This module runs on Bun.
 *
 * @module
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** What to generate a contract of. */
export interface ContractOptions {
  /** The module that exports the application. */
  readonly entry: string;

  /** The export that holds the application; `"default"` for a default export. Defaults to `"app"`. */
  readonly export?: string;

  /** The name of the contract's interface. Defaults to `"Api"`. */
  readonly name?: string;

  /** The `tsconfig.json` to compile with. Defaults to the one nearest to the entry. */
  readonly tsconfig?: string;
}

/** The command, beside this module: `.ts` in the repository, `.js` once built. */
const cli = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js",
    import.meta.url,
  ),
);

/**
 * The contract of the application `options.entry` exports, as the text of
 * a `.d.ts`. Rejects with what kept it from being written: a module that
 * does not compile, an export that is not an application, a type the
 * contract cannot hold.
 */
export async function generateContract(
  options: ContractOptions,
): Promise<string> {
  const args = ["contract", resolve(options.entry)];

  if (options.export !== undefined) args.push("--export", options.export);
  if (options.name !== undefined) args.push("--name", options.name);
  if (options.tsconfig !== undefined) {
    args.push("--tsconfig", resolve(options.tsconfig));
  }

  const child = Bun.spawn([process.execPath, cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [text, failure, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0) {
    throw new Error(
      failure.trim() || `tetsu-client contract exited with ${code}`,
    );
  }

  return text;
}
