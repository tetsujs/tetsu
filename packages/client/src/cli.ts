#!/usr/bin/env bun
/**
 * `tetsu-client`: the contract of an application, written for a frontend
 * that cannot import the server — a Next or SvelteKit app without Bun's
 * types, or another repository altogether.
 *
 * ```json
 * "scripts": {
 *   "contract": "tetsu-client contract src/app.ts --out ../web/src/api.contract.d.ts",
 *   "contract:watch": "tetsu-client contract src/app.ts --out ../web/src/api.contract.d.ts --watch"
 * }
 * ```
 *
 * The compiler it works the contract out with is TypeScript 6.0.3, whatever
 * the application compiles with: TypeScript 7 has no stable API to read
 * types through. Bun installs it into its own cache the first time, so
 * neither the server nor the frontend lists it.
 *
 * It does so in a process of its own — `bun --install=force` — which is
 * the one that imports the compiler. The command starts that process and
 * passes it the command line; `generateContract` starts it too.
 *
 * @module
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type * as TS from "typescript6";
import type { ContractSource, Setup } from "./print.ts";
import {
  ContractProblem,
  hostWith,
  printContract,
  setup,
  systemWith,
} from "./print.ts";
import { isSameCode } from "./same-code.ts";

type Ts = typeof TS;

const usage = `Usage: tetsu-client contract <entry> [options]

Writes the contract of the application <entry> exports: a .d.ts a frontend
creates its client with, without the server's code.

Options:
  --out <path>        Where the contract goes (default: printed)
  --export <name>     The export that holds the application, or a function
                      that returns it (default: app)
  --name <name>       The name of the contract's interface (default: Api)
  --tsconfig <path>   The tsconfig.json to compile with (default: the nearest)
  --check             Check that the contract at --out is up to date, and write nothing
  --watch             Write the contract again whenever the application changes
  -h, --help          Show this`;

/** The compiler the contract is worked out with, as Bun installs it. */
export const TYPESCRIPT = "typescript@6.0.3";

/** Set in the environment of the process that does the work. */
export const WORKER = "TETSU_CLIENT_WORKER";

/** A mistake in how the command was called, answered with the usage. */
class UsageError extends Error {
  override readonly name = "UsageError";
}

interface Command {
  readonly source: ContractSource;
  readonly out: string | undefined;
  readonly check: boolean;
  readonly watch: boolean;
}

function parse(argv: readonly string[]): Command | "help" {
  let parsed: ReturnType<typeof read>;

  try {
    parsed = read(argv);
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }

  const { values, positionals } = parsed;

  if (values.help === true) {
    return "help";
  }

  const [command, entry, ...rest] = positionals;

  if (command !== "contract") {
    throw new UsageError(
      command === undefined
        ? "No command given"
        : `Unknown command: ${command}`,
    );
  }

  if (entry === undefined || rest.length > 0) {
    throw new UsageError("contract takes one entry module");
  }

  if (
    (values.check === true || values.watch === true) &&
    values.out === undefined
  ) {
    throw new UsageError(
      `--${values.check === true ? "check" : "watch"} needs --out`,
    );
  }

  if (
    values.name !== undefined &&
    (!/^[A-Za-z_$][\w$]*$/.test(values.name) ||
      values.name === "AnyHeaders" ||
      values.name === "Raw")
  ) {
    throw new UsageError(
      `--name ${values.name} is not a name the contract can take: an identifier, other than AnyHeaders and Raw`,
    );
  }

  if (values.check === true && values.watch === true) {
    throw new UsageError("--check and --watch do not go together");
  }

  return {
    source: {
      entry: resolve(entry),
      exportName: values.export ?? "app",
      name: values.name ?? "Api",
      tsconfig:
        values.tsconfig === undefined ? undefined : resolve(values.tsconfig),
    },
    out: values.out === undefined ? undefined : resolve(values.out),
    check: values.check === true,
    watch: values.watch === true,
  };
}

function read(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      out: { type: "string" },
      export: { type: "string" },
      name: { type: "string" },
      tsconfig: { type: "string" },
      check: { type: "boolean" },
      watch: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}

/**
 * The compiler, imported by version. Bun allows a version in an import only
 * from a module no `package.json` with dependencies stands above — not this
 * one, inside the client's package — so the import is made by a module
 * written to a directory of its own in the system's temporary directory.
 */
export async function typescript(): Promise<Ts> {
  const directory = await mkdtemp(join(tmpdir(), "tetsu-client-"));
  const loader = join(directory, "typescript.mjs");

  try {
    await Bun.write(loader, `export { default } from "${TYPESCRIPT}";\n`);

    const loaded = (await import(loader)) as { default: Ts };

    return loaded.default;
  } catch (error) {
    throw new ContractProblem(
      `Could not load ${TYPESCRIPT}, which Bun installs on first use: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Writes `text` to `out` unless it holds that code already, in whatever
 * layout a formatter gave it; says whether it wrote.
 */
async function write(out: string, text: string): Promise<boolean> {
  const file = Bun.file(out);

  if ((await file.exists()) && isSameCode(await file.text(), text)) {
    return false;
  }

  await mkdir(dirname(out), { recursive: true });
  await Bun.write(out, text);

  return true;
}

async function work(command: Command): Promise<number> {
  if (!(await Bun.file(command.source.entry).exists())) {
    throw new ContractProblem(`${command.source.entry} does not exist`);
  }

  const ts = await typescript();
  const prepared = setup(ts, command.source, import.meta.dir);

  if (command.watch && command.out !== undefined) {
    watch(ts, prepared, command.source, command.out);

    return await new Promise<number>(() => undefined);
  }

  const program = ts.createProgram({
    rootNames: [prepared.root],
    options: prepared.options,
    host: hostWith(ts, prepared),
  });
  const text = printContract(ts, program, prepared, command.source);

  if (command.out === undefined) {
    process.stdout.write(text);

    return 0;
  }

  if (command.check) {
    const file = Bun.file(command.out);
    const current = (await file.exists()) ? await file.text() : undefined;

    if (current !== undefined && isSameCode(current, text)) {
      console.log(`${command.out} is up to date`);

      return 0;
    }

    console.error(
      `${command.out} ${current === undefined ? "does not exist" : "is out of date"}: run tetsu-client contract without --check`,
    );

    return 1;
  }

  const wrote = await write(command.out, text);

  console.log(wrote ? `Wrote ${command.out}` : `${command.out} is up to date`);

  return 0;
}

/**
 * Writes the contract each time the compiler sees the program change —
 * the application, or any module it imports — and only when the contract
 * itself changed, so a frontend's dev server does not reload for nothing.
 * A problem is told and waited out.
 */
function watch(ts: Ts, prepared: Setup, source: ContractSource, out: string) {
  const host = ts.createWatchCompilerHost(
    [prepared.root],
    prepared.options,
    systemWith(ts, prepared),
    ts.createSemanticDiagnosticsBuilderProgram,
    () => undefined,
    () => undefined,
  );

  host.afterProgramCreate = (builder) => {
    let text: string;

    try {
      text = printContract(ts, builder.getProgram(), prepared, source);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));

      return;
    }

    write(out, text).then(
      (wrote) => {
        if (wrote) {
          console.log(`Wrote ${out}`);
        }
      },
      (error: unknown) => console.error(error),
    );
  };

  ts.createWatchProgram(host);
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
}

/**
 * Runs the command in a process that can import the compiler, and ends
 * as it ends. A signal is passed on to it; and it holds this process's
 * end of a pipe as its input, so that it stops when this one is gone,
 * killed outright too, rather than watch on alone.
 */
async function delegate(argv: readonly string[]): Promise<number> {
  const child = Bun.spawn(
    [process.execPath, "--install=force", import.meta.path, ...argv],
    {
      env: { ...process.env, [WORKER]: "1" },
      stdio: ["pipe", "inherit", "inherit"],
    },
  );

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => child.kill(signal));
  }

  return await child.exited;
}

async function main(argv: readonly string[]): Promise<number> {
  let command: Command | "help";

  try {
    command = parse(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${usage}`);

      return 2;
    }

    throw error;
  }

  if (command === "help") {
    console.log(usage);

    return 0;
  }

  if (process.env[WORKER] === undefined) {
    return await delegate(argv);
  }

  try {
    return await work(command);
  } catch (error) {
    if (error instanceof ContractProblem) {
      console.error(error.message);

      return 1;
    }

    throw error;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
