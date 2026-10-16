/**
 * The generator of contracts: `generateContract` and the `tetsu-client
 * contract` command, run as a script runs them — each in processes of its
 * own, the compiler installed by Bun.
 *
 * That the generated contract is the type `ContractOf<typeof app>` is
 * `contract.test-d.ts`; here, that the committed contract is what the
 * generator writes today, so that test is about the current printer.
 *
 * @module
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript6";
import { generateContract } from "./contract.ts";

setDefaultTimeout(30_000);

const cli = join(import.meta.dir, "cli.ts");
const root = join(import.meta.dir, "../../..");
const utils = join(import.meta.dir, "../test-utils");
const app = join(utils, "contract-app.ts");
const shapes = join(utils, "contract-shapes.ts");
const committed = join(utils, "contract-app.contract.d.ts");
const strictest = join(root, "tsconfig.strictest.json");

/**
 * A directory for files a test writes, inside the repository: an
 * application there resolves `@tetsujs/core` through its `tsconfig.json`.
 */
const scratch = await mkdtemp(join(utils, "scratch-"));

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(args: readonly string[]): Promise<Run> {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, stdout, stderr };
}

/**
 * What the compiler finds wrong with a contract, read as a frontend reads
 * it — the DOM's globals, no Bun — and with library checks on, which
 * frontends leave off: with `skipLibCheck` a name the contract does not
 * declare is an `any` nobody sees.
 */
function problems(contract: string): string[] {
  const program = ts.createProgram([contract], {
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    paths: { "@tetsujs/client": [join(import.meta.dir, "index.ts")] },
  });

  return ts
    .getPreEmitDiagnostics(program)
    .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"));
}

describe("generateContract", () => {
  test("writes the committed contract, the same each time", async () => {
    const first = await generateContract({ entry: app, tsconfig: strictest });
    const second = await generateContract({ entry: app, tsconfig: strictest });

    expect(first).toBe(await Bun.file(committed).text());
    expect(second).toBe(first);
  });

  test("loads the pinned compiler, whatever the repository compiles with", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--install=force",
        "-e",
        `import { typescript } from ${JSON.stringify(cli)};\nconsole.log((await typescript()).version);`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    expect((await new Response(child.stdout).text()).trim()).toBe("6.0.3");
    expect(await child.exited).toBe(0);
  });

  test("writes a contract that compiles on its own, library checks on", () => {
    expect(problems(committed)).toEqual([]);
  });

  test("does not shadow a global with a recursive type of the same name", async () => {
    const text = await generateContract({ entry: shapes, export: "shadowing" });
    const out = join(scratch, "shadowing.d.ts");

    await Bun.write(out, text);

    expect(text).toContain("upload: File;");
    expect(text).toContain("export interface File2 {");
    expect(problems(out)).toEqual([]);
  });

  test("strips brands, and reads another export under another name", async () => {
    const branded = await generateContract({
      entry: shapes,
      export: "branded",
      name: "Accounts",
    });

    expect(branded).toContain("export interface Accounts {");
    expect(branded).toContain("id: number;");
    expect(branded).toContain("id: string;\n        owner: string | null;");
    expect(branded).not.toContain("brand");

    const health = await generateContract({ entry: shapes, export: "default" });

    expect(health).toContain('readonly "GET /health"');
  });

  test("rejects an export that is not an application", async () => {
    const generated = generateContract({ entry: shapes, export: "notAnApp" });

    await expect(generated).rejects.toThrow(
      `notAnApp of ${shapes} is not a Tetsu application`,
    );
  });

  test("rejects a missing export or entry", async () => {
    await expect(
      generateContract({ entry: shapes, export: "nowhere" }),
    ).rejects.toThrow(`${shapes} has no export named nowhere`);
    await expect(
      generateContract({ entry: join(scratch, "nothing.ts") }),
    ).rejects.toThrow("nothing.ts does not exist");
  });

  test("tells what is wrong with the application, rather than write part of it", async () => {
    const entry = join(scratch, "broken.ts");
    const routes = join(scratch, "routes.ts");

    await Bun.write(
      routes,
      'import { route } from "@tetsujs/core";\n\nexport const health = route({ method: "GET", path: "/health", handler: () => "ok" }\n',
    );
    await Bun.write(
      entry,
      'import { createApp } from "@tetsujs/core";\nimport { health } from "./routes.ts";\n\nexport const app = createApp({ routes: [health] });\n',
    );

    await expect(generateContract({ entry })).rejects.toThrow(
      `${routes}:4:1: ')' expected.`,
    );

    await Bun.write(
      routes,
      'import { route } from "@tetsujs/core";\n\nexport const health = route({ method: "GET", path: "/health", handler: () => "ok" });\n',
    );
    await Bun.write(
      entry,
      'import { createApp } from "@tetsujs/core";\nimport { health } from "./routes.ts";\n\nexport const app = createApp({ routes: [health], nope: 1 });\n',
    );

    await expect(generateContract({ entry })).rejects.toThrow(`${entry}:4:`);
  });

  test("names each place it cannot write, rather than writing any", async () => {
    const generated = generateContract({ entry: shapes, export: "unwritable" });

    await expect(generated).rejects.toThrow(
      [
        "Cannot write the contract of contract-shapes.ts:",
        "  Api → POST /callbacks → request → body → onDone: a function",
        "  Api → POST /handlers → request → body → handlers: a function",
        "  Api → POST /symbols → request → body → tag: a symbol",
        "  Api → POST /rewrites → request → body → rewriter: HTMLRewriter, a global the frontend does not have",
        "  Api → POST /missing → request → body → value: a type that did not resolve",
      ].join("\n"),
    );
  });
});

describe("tetsu-client contract", () => {
  test("prints the contract without --out", async () => {
    const result = await run(["contract", app, "--tsconfig", strictest]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(await Bun.file(committed).text());
  });

  test("writes --out, and leaves a file that holds the same code alone", async () => {
    const out = join(scratch, "web", "api.contract.d.ts");
    const args = ["contract", app, "--tsconfig", strictest, "--out", out];

    const wrote = await run(args);

    expect(wrote.exitCode).toBe(0);
    expect(wrote.stdout).toBe(`Wrote ${out}\n`);
    expect(await Bun.file(out).text()).toBe(await Bun.file(committed).text());

    const formatted = (await Bun.file(out).text()).replaceAll("  ", "\t");

    await Bun.write(out, formatted);

    const before = (await stat(out)).mtimeMs;
    const again = await run(args);

    expect(again.stdout).toBe(`${out} is up to date\n`);
    expect((await stat(out)).mtimeMs).toBe(before);
    expect(await Bun.file(out).text()).toBe(formatted);
  });

  test("--check passes on the same code and fails on other code", async () => {
    const out = join(scratch, "check.d.ts");
    const args = ["contract", app, "--tsconfig", strictest, "--out", out];

    const missing = await run([...args, "--check"]);

    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toBe(
      `${out} does not exist: run tetsu-client contract without --check\n`,
    );

    await Bun.write(
      out,
      (await Bun.file(committed).text()).replaceAll("  ", "\t"),
    );

    const passed = await run([...args, "--check"]);

    expect(passed.exitCode).toBe(0);
    expect(passed.stdout).toBe(`${out} is up to date\n`);

    await Bun.write(
      out,
      (await Bun.file(committed).text()).replace("id: number;", "id: string;"),
    );

    const failed = await run([...args, "--check"]);

    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toBe(
      `${out} is out of date: run tetsu-client contract without --check\n`,
    );
    expect(await Bun.file(out).text()).toContain("id: string;");
  });

  test("answers a mistake in the command line with the usage", async () => {
    for (const args of [
      [],
      ["generate", app],
      ["contract"],
      ["contract", app, "--check"],
      ["contract", app, "--watch"],
      ["contract", app, "--out", "x.d.ts", "--check", "--watch"],
      ["contract", app, "--nope"],
      ["contract", app, "--name", "my-api"],
      ["contract", app, "--name", "Raw"],
    ]) {
      const result = await run(args);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Usage: tetsu-client contract <entry>");
    }
  });

  test("--watch writes the contract again when the application changes, and stops with the command", async () => {
    const entry = join(scratch, "watched.ts");
    const out = join(scratch, "watched.d.ts");
    const source = (path: string) =>
      [
        'import { createApp, route } from "@tetsujs/core";',
        "",
        "export const app = createApp({",
        `  routes: [route({ method: "GET", path: "${path}", handler: () => "ok" })],`,
        "});",
        "",
      ].join("\n");

    await Bun.write(entry, source("/first"));

    const child = Bun.spawn(
      [process.execPath, cli, "contract", entry, "--out", out, "--watch"],
      { stdout: "pipe", stderr: "pipe" },
    );

    try {
      await until(async () => (await read(out)).includes('"GET /first"'));
      await Bun.write(entry, source("/second"));
      await until(async () => (await read(out)).includes('"GET /second"'));
      await Bun.write(entry, source("/third").replace("});", "}"));
      await Bun.sleep(1500);

      expect(await read(out)).toContain('"GET /second"');
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }

    await Bun.sleep(300);
    await Bun.write(entry, source("/fourth"));
    await Bun.sleep(1500);

    expect(await read(out)).toContain('"GET /second"');
  });
});

async function read(path: string): Promise<string> {
  const file = Bun.file(path);

  return (await file.exists()) ? await file.text() : "";
}

async function until(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;

  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error("Timed out");
    }

    await Bun.sleep(50);
  }
}
