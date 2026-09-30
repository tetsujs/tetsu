import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TwoslashOptions } from "@ec-ts/twoslash";

type Node = Parameters<NonNullable<TwoslashOptions["filterNode"]>>[0];

/**
 * The site's own directory. The build bundles the config into `dist/`, so
 * `import.meta.url` is only where the search starts.
 */
function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));

  while (!existsSync(join(dir, "twoslash.config.ts"))) {
    const parent = dirname(dir);

    if (parent === dir)
      throw new Error("twoslash.config.ts: the site's directory was not found");

    dir = parent;
  }

  return dir;
}

const root = findRoot();
const packages = join(root, "../packages/");

const machinery =
  /\b(?:BaseCtx|RawParams|RouteDef|RouteConfig|Hook|HookFactory|HooksInput|SchemaConfig|Zod\w*)\b|\$strip/;

/**
 * A framework error reads as the sentence it carries, not as the two
 * branded types TypeScript compares to get there.
 */
function ownMessage(text: string): string {
  const own = /\w+Error<"((?:[^"\\]|\\.)*)">/.exec(text);

  return own ? own[1] : text;
}

/**
 * `(property) ServerWebSocket<{ … }>.data: { … }` reads as `data: { … }`:
 * the type that owns a field is noise next to the field's own type.
 */
function unqualify(text: string): string {
  const kind = /^\((?:property|method)\) /.exec(text)?.[0] ?? "";
  const rest = text.slice(kind.length);
  let depth = 0;
  let dot = -1;

  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index];

    if (depth === 0 && (char === ":" || char === "(")) break;
    if ("<{[(".includes(char)) depth += 1;
    else if (">}])".includes(char)) depth -= 1;
    else if (depth === 0 && char === ".") dot = index;
  }

  return dot < 0 ? text : kind + rest.slice(dot + 1);
}

/**
 * A hover earns its place when it shows a value's type in words the reader
 * already knows: `ctx` and what is on it, a local, a parameter. Imports,
 * functions, a route's own config and the framework's internal types stay
 * out; a `^?` query and a compiler error always stay. A query shows the type
 * alone, and no hover carries a borrowed `@example`.
 */
function isUseful(node: Node): boolean {
  if (node.type === "error") {
    node.text = ownMessage(node.text);

    return true;
  }

  if (node.type !== "hover" && node.type !== "query") return true;

  node.text = unqualify(node.text);
  node.tags = node.tags?.filter(([name]) => name !== "example");

  if (node.type === "query") {
    node.docs = undefined;
    node.tags = undefined;

    return true;
  }

  const { text } = node;

  if (!/^(?:\(parameter\)|\(property\)|const |let )/.test(text)) return false;
  if (machinery.test(text)) return false;

  return text.split("\n").length <= 16;
}

/**
 * What every example on the site is compiled with: the packages of this
 * commit, from their sources, under the strictness a user is told to use.
 */
export const twoslashOptions: TwoslashOptions = {
  vfsRoot: root,
  filterNode: isUseful,
  compilerOptions: {
    strict: true,
    target: 99,
    module: 200,
    moduleResolution: 100,
    types: ["bun"],
    paths: {
      "@tetsujs/core/testing": [`${packages}core/test-utils/index.ts`],
      "@tetsujs/openapi/testing": [`${packages}openapi/src/testing.ts`],
      "@tetsujs/*": [`${packages}*/src/index.ts`],
    },
  },
};
