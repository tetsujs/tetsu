/**
 * The printer of a contract: the routes of an application, worked out by
 * the compiler as `ContractOf<typeof app>`, written out as plain types — a
 * `.d.ts` a frontend reads without the server's code, its validators or
 * Bun.
 *
 * It runs on the JavaScript API of TypeScript 6, which it is handed rather
 * than imports: the generator loads one pinned version of it, whatever
 * version the application compiles with.
 *
 * What it writes:
 * - each route's `request` and `responses` as the client reads them, with
 *   the statuses as numbers;
 * - a type the core's DOM and ECMAScript libraries declare — `Date`,
 *   `File`, `Blob` — by its name;
 * - `AnyHeaders` and `Raw` by name, imported from `@tetsujs/client`;
 * - a recursive type as an interface of its own, named after the type it
 *   came from;
 * - a brand — a property keyed by a symbol — not at all: the frontend
 *   sends and receives the plain value.
 *
 * What it cannot write — a function, a symbol, a type that failed to
 * resolve, a global only Bun declares — is a {@link ContractProblem}
 * naming each place, rather than an `any` the frontend would not notice.
 *
 * @module
 */

import { basename, dirname, extname, join } from "node:path";
import type * as TS from "typescript6";

type Ts = typeof TS;

/** Where the routes come from, and what the contract is called. */
export interface ContractSource {
  /** The module that exports the application, as an absolute path. */
  readonly entry: string;

  /** The name the application is exported under; `default` for a default export. */
  readonly exportName: string;

  /** The name of the contract's interface. */
  readonly name: string;

  /** The `tsconfig.json` to compile with; the one nearest to the entry when left out. */
  readonly tsconfig?: string | undefined;
}

/** What kept a contract from being printed, place by place. */
export class ContractProblem extends Error {
  override readonly name = "ContractProblem";
}

/** The module the generated file imports its named types from. */
const CLIENT = "@tetsujs/client";

/** `CheckFlags.Readonly` of the compiler: a property a mapped type made `readonly`. */
const READONLY = 8;

/** `CheckFlags.Mapped`: a property a mapped type made, whose flags say what it is. */
const MAPPED = 1 << 18;

/**
 * The compiler options and the root file the contract is worked out in: a
 * module of its own, beside the entry, that imports the application and
 * names its contract. An export that is a function is read as what it
 * returns, awaited: the application built from its dependencies.
 */
export interface Setup {
  readonly root: string;
  readonly client: string;
  readonly text: string;
  readonly options: TS.CompilerOptions;
  /** Whether the application's own tsconfig has `exactOptionalPropertyTypes`. */
  readonly exact: boolean;
}

/**
 * Works out the options from the application's `tsconfig.json` — its
 * paths, its types, Bun's among them — and writes the root module.
 * `client` is the directory of the client's own modules, the types of
 * which the root imports.
 */
export function setup(ts: Ts, source: ContractSource, client: string): Setup {
  const directory = dirname(source.entry);
  const root = join(directory, "__tetsu_contract__.ts").replaceAll("\\", "/");
  const text = [
    `import type { ContractOf } from ${JSON.stringify(specifier(join(client, "routes.ts")))};`,
    `import type { AnyHeaders, Raw } from ${JSON.stringify(specifier(join(client, "types.ts")))};`,
    `import type * as Server from ${JSON.stringify(specifier(source.entry))};`,
    "type Built<T> = T extends (...args: never) => infer A ? Awaited<A> : T;",
    `export type Contract = ContractOf<Built<typeof Server[${JSON.stringify(source.exportName)}]>>;`,
    "export type Headers = AnyHeaders;",
    "export type Unread = Raw<string>;",
    'export type Stream = NonNullable<RequestInit["body"]>;',
    "",
  ].join("\n");

  const compiled = options(ts, source, directory);

  return {
    root,
    client: `${client.replaceAll("\\", "/").replace(/\/$/, "")}/`,
    text,
    options: { ...compiled, ...EXACT },
    exact: compiled.exactOptionalPropertyTypes === true,
  };
}

/**
 * The contract is worked out with `exactOptionalPropertyTypes`, whatever
 * the application compiles with: only then does the compiler tell the
 * `undefined` an optional property declares — `z.string().optional()`
 * does — from the one its `?` adds, and the contract keeps the first, so
 * a frontend with the flag can pass `undefined` where the server takes it.
 */
const EXACT: TS.CompilerOptions = { exactOptionalPropertyTypes: true };

/**
 * What only `exactOptionalPropertyTypes` finds wrong: the application's
 * concern when its own tsconfig has the flag, not otherwise.
 */
const EXACT_ONLY = new Set([2375, 2379, 2412]);

/**
 * A module as an import names it: with the extension of what it compiles
 * to, which every resolution mode maps back to the source.
 */
function specifier(path: string): string {
  const extension = extname(path);
  const output =
    extension === ".mts" ? ".mjs" : extension === ".cts" ? ".cjs" : ".js";

  return (path.slice(0, -extension.length) + output).replaceAll("\\", "/");
}

function options(
  ts: Ts,
  source: ContractSource,
  directory: string,
): TS.CompilerOptions {
  const forced: TS.CompilerOptions = {
    noEmit: true,
    declaration: false,
    composite: false,
    incremental: false,
    emitDeclarationOnly: false,
    skipLibCheck: true,
    ignoreDeprecations: "6.0",
  };
  const path =
    source.tsconfig ?? ts.findConfigFile(directory, ts.sys.fileExists);

  if (path === undefined) {
    return {
      strict: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      ...forced,
    };
  }

  const read = ts.readConfigFile(path, ts.sys.readFile);

  if (read.error !== undefined) {
    throw new ContractProblem(diagnostic(ts, read.error));
  }

  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(path),
    undefined,
    path,
  );
  const errors = parsed.errors.filter(
    (error) => error.category === ts.DiagnosticCategory.Error,
  );

  if (errors.some((error) => error.code !== NO_INPUTS)) {
    throw new ContractProblem(
      errors.map((error) => diagnostic(ts, error)).join("\n"),
    );
  }

  return { ...parsed.options, ...forced };
}

/** "No inputs were found in config file": the contract names its own root. */
const NO_INPUTS = 18003;

function diagnostic(ts: Ts, error: TS.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(error.messageText, "\n");

  if (error.file === undefined || error.start === undefined) {
    return message;
  }

  const { line, character } = error.file.getLineAndCharacterOfPosition(
    error.start,
  );

  return `${error.file.fileName}:${line + 1}:${character + 1}: ${message}`;
}

/**
 * A system that holds the root module in memory: the compiler reads it
 * as a file, and a watch never waits for it to change.
 */
export function systemWith(ts: Ts, { root, text }: Setup): TS.System {
  return {
    ...ts.sys,
    readFile: (path, encoding) =>
      path === root ? text : ts.sys.readFile(path, encoding),
    fileExists: (path) => path === root || ts.sys.fileExists(path),
    watchFile: (path, callback, interval, options) =>
      path === root || ts.sys.watchFile === undefined
        ? { close: () => undefined }
        : ts.sys.watchFile(path, callback, interval, options),
  };
}

/** A compiler host that reads the root module from memory. */
export function hostWith(ts: Ts, setup: Setup): TS.CompilerHost {
  const host = ts.createCompilerHost(setup.options);
  const system = systemWith(ts, setup);

  host.readFile = (path) => system.readFile(path);
  host.fileExists = (path) => system.fileExists(path);

  return host;
}

/**
 * The contract of the program's root module, as the text of a `.d.ts`.
 * Throws a {@link ContractProblem} when the module does not compile, the
 * export is not an application, or a type cannot be written out.
 */
export function printContract(
  ts: Ts,
  program: TS.Program,
  setup: Setup,
  source: ContractSource,
): string {
  const file = program.getSourceFile(setup.root);

  if (file === undefined) {
    throw new ContractProblem(`Could not read ${source.entry}`);
  }

  fail(
    ts,
    program
      .getSourceFiles()
      .filter((source) => !source.isDeclarationFile)
      .flatMap((source) => program.getSyntacticDiagnostics(source)),
  );

  const checker = program.getTypeChecker();
  const server = file.statements.find(
    (statement): statement is TS.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamespaceImport(statement.importClause.namedBindings),
  );
  const module =
    server === undefined
      ? undefined
      : checker.getSymbolAtLocation(server.moduleSpecifier);

  if (
    module !== undefined &&
    !checker
      .getExportsOfModule(module)
      .some((symbol) => symbol.name === source.exportName)
  ) {
    throw new ContractProblem(
      `${source.entry} has no export named ${source.exportName}`,
    );
  }

  const entry = program.getSourceFile(source.entry.replaceAll("\\", "/"));

  fail(
    ts,
    [
      ...(entry === undefined ? [] : program.getSemanticDiagnostics(entry)),
      ...program.getSemanticDiagnostics(file),
    ].filter((error) => setup.exact || !EXACT_ONLY.has(error.code)),
  );

  const named = (name: string): TS.Type => {
    const alias = file.statements.find(
      (statement): statement is TS.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
    );

    if (alias === undefined) {
      throw new Error(`The root module declares no ${name}`);
    }

    return checker.getTypeAtLocation(alias.name);
  };
  const contract = named("Contract");
  const routes = checker.getPropertiesOfType(contract);
  const strangers = routes.filter((route) => !ROUTE.test(route.name));

  if (routes.length === 0 || strangers.length > 0) {
    throw new ContractProblem(
      `${source.exportName} of ${source.entry} is not a Tetsu application, nor a function that returns one: its type carries no routes`,
    );
  }

  const printer = new Printer(ts, checker, {
    headers: named("Headers"),
    raw: (named("Unread") as TS.TypeReference).target,
    stream: named("Stream"),
    reserved: source.name,
    client: setup.client,
  });
  const body = printer.members(contract, [source.name]);

  if (printer.problems.length > 0) {
    throw new ContractProblem(
      `Cannot write the contract of ${basename(source.entry)}:\n${printer.problems.map((problem) => `  ${problem}`).join("\n")}`,
    );
  }

  const imports = [...printer.imports].sort();

  return [
    `// Generated by \`tetsu-client contract\` from ${basename(source.entry)}. Do not edit.`,
    "",
    ...(imports.length > 0
      ? [`import type { ${imports.join(", ")} } from "${CLIENT}";`, ""]
      : []),
    `export interface ${source.name} ${block(body)}`,
    ...printer.hoisted.flatMap((declaration) => ["", declaration]),
    "",
  ].join("\n");
}

const ROUTE = /^(GET|POST|PUT|PATCH|DELETE) \//;

/**
 * Throws the errors the compiler found, if it found any. What is checked
 * is the syntax of every module of the application — a route half written
 * would otherwise drop out of the contract — and the types of the module
 * that exports it, not of every module: TypeScript 6 is not the compiler
 * the application is checked with, and may find what that one does not.
 */
function fail(ts: Ts, errors: readonly TS.Diagnostic[]): void {
  if (errors.length > 0) {
    throw new ContractProblem(
      errors.map((error) => diagnostic(ts, error)).join("\n"),
    );
  }
}

/** Lines in braces, each indented a step further. */
function block(lines: readonly string[]): string {
  if (lines.length === 0) {
    return "{}";
  }

  const indented = lines.map((line) =>
    line
      .split("\n")
      .map((part) => `  ${part}`)
      .join("\n"),
  );

  return `{\n${indented.join("\n")}\n}`;
}

/**
 * A property's type after its colon: on the same line, or — a union of
 * objects, which Prettier lays out a member to a line, each after a `|` —
 * on the lines below.
 */
function after(printed: string): string {
  return printed.startsWith("\n")
    ? printed.replaceAll("\n", "\n  ")
    : ` ${printed}`;
}

/** A type in parentheses where an array's `[]` needs them. */
function grouped(printed: string): string {
  if (printed.startsWith("\n")) {
    return `(${printed.replaceAll("\n", "\n  ")}\n)`;
  }

  return spread(printed) ? `(${printed})` : printed;
}

/**
 * Whether a printed type has a `|`, an `&` or a space outside its
 * brackets and literals — `{} | null`, `readonly string[]` — as opposed
 * to one whole: `{ a: string | null }`, `` `a ${string}` ``.
 */
function spread(printed: string): boolean {
  const open: string[] = [];

  for (let index = 0; index < printed.length; index += 1) {
    const char = printed[index] ?? "";
    const inside = open.at(-1);

    if (inside === '"' || inside === "`") {
      if (char === "\\") {
        index += 1;
      } else if (char === inside) {
        open.pop();
      } else if (inside === "`" && printed.startsWith("${", index)) {
        open.push("{");
        index += 1;
      }

      continue;
    }

    if ('"`{([<'.includes(char)) {
      open.push(char);
    } else if ("})]>".includes(char)) {
      open.pop();
    } else if (open.length === 0 && /[|&\s]/.test(char)) {
      return true;
    }
  }

  return false;
}

/** The text of a template literal type, escaped as its source writes it, on one line. */
function template(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

/** A property name as a type literal writes it: bare when it can be. */
function key(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) || /^(0|[1-9]\d*)$/.test(name)
    ? name
    : JSON.stringify(name);
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** A type the global scope declares under `name`, through the compiler's own lookup. */
function resolveName(
  checker: TS.TypeChecker,
  ts: Ts,
  name: string,
): TS.Symbol | undefined {
  return (
    checker as TS.TypeChecker & {
      resolveName(
        name: string,
        location: TS.Node | undefined,
        meaning: TS.SymbolFlags,
        excludeGlobals: boolean,
      ): TS.Symbol | undefined;
    }
  ).resolveName(name, undefined, ts.SymbolFlags.Type, false);
}

interface Known {
  /** `AnyHeaders`, as the root module resolved it. */
  readonly headers: TS.Type;

  /** The generic `Raw`. */
  readonly raw: TS.Type;

  /** The body of a `stream` route, as the server's libraries declare it. */
  readonly stream: TS.Type;

  /** The contract's own name, which a hoisted type must not take. */
  readonly reserved: string;

  /** The directory of the client's modules, ending in a separator. */
  readonly client: string;
}

/**
 * A checker of what a frontend's globals are: the ECMAScript and DOM
 * libraries, and nothing from `@types` — Bun's least of all.
 */
function frontend(ts: Ts): TS.TypeChecker {
  const root = "/__tetsu_frontend__.ts";
  const options: TS.CompilerOptions = {
    lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
    types: [],
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);

  host.getSourceFile = (path, version, ...rest) =>
    path === root
      ? ts.createSourceFile(root, "export {};\n", version)
      : read(path, version, ...rest);

  return ts
    .createProgram({ rootNames: [root], options, host })
    .getTypeChecker();
}

/** Writes types out, gathering what it hoists, imports and cannot write. */
class Printer {
  readonly problems: string[] = [];
  readonly hoisted: string[] = [];
  readonly imports = new Set<string>();

  private readonly names = new Map<TS.Type, string>();
  private readonly taken = new Set<string>();
  private readonly open = new Set<TS.Type>();
  private readonly lib: TS.TypeChecker;

  constructor(
    private readonly ts: Ts,
    private readonly checker: TS.TypeChecker,
    private readonly known: Known,
  ) {
    for (const name of [known.reserved, "AnyHeaders", "Raw"]) {
      this.taken.add(name);
    }

    this.lib = frontend(ts);
  }

  /** The members of an object type, a line each. */
  members(type: TS.Type, path: readonly string[]): string[] {
    return [...this.indexes(type, path), ...this.properties(type, path)];
  }

  /**
   * An object type's body: its members in a block — or, when a property
   * does not fit its index signature, as `.catchall()` makes it, the
   * properties and the signature in two, `{ a: string } & { [key:
   * string]: number }`, which a type literal cannot say in one.
   */
  private body(type: TS.Type, path: readonly string[]): string {
    if (!this.clashes(type)) {
      return block(this.members(type, path));
    }

    return `${block(this.properties(type, path))} & ${block(this.indexes(type, path))}`;
  }

  private indexes(type: TS.Type, path: readonly string[]): string[] {
    return this.checker.getIndexInfosOfType(type).map((info) => {
      const modifier = info.isReadonly ? "readonly " : "";

      return `${modifier}[key: ${this.print(info.keyType, path)}]:${after(this.print(info.type, path))};`;
    });
  }

  private properties(type: TS.Type, path: readonly string[]): string[] {
    const { ts, checker } = this;
    const lines: string[] = [];

    for (const property of checker.getPropertiesOfType(type)) {
      if (property.escapedName.toString().startsWith("__@")) {
        continue;
      }

      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
      const value = checker.getTypeOfSymbol(property);
      const at = [...path, property.name];
      const printed = optional
        ? this.defined(value, at)
        : this.print(value, at);

      lines.push(
        `${this.readonly(property) ? "readonly " : ""}${key(property.name)}${optional ? "?" : ""}:${after(printed)};`,
      );
    }

    if (
      checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
      checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0
    ) {
      this.problem(path, "a function");
    }

    return lines;
  }

  /** Whether a property's type is not one its index signature allows. */
  private clashes(type: TS.Type): boolean {
    const { ts, checker } = this;
    const infos = checker.getIndexInfosOfType(type);

    if (infos.length === 0) {
      return false;
    }

    return checker.getPropertiesOfType(type).some((property) => {
      const name = property.escapedName.toString();

      if (name.startsWith("__@")) {
        return false;
      }

      return infos.some((info) => {
        const applies =
          info.keyType.flags & ts.TypeFlags.Number
            ? /^(0|[1-9]\d*)$/.test(name)
            : checker.isTypeAssignableTo(
                checker.getStringLiteralType(name),
                info.keyType,
              );

        return (
          applies &&
          !checker.isTypeAssignableTo(
            checker.getTypeOfSymbol(property),
            info.type,
          )
        );
      });
    });
  }

  /**
   * Whether a property is `readonly`. One a mapped type made — `Jsonify`'s,
   * which takes `readonly` off — says so in its own flags, whatever the
   * declaration it was mapped from says; a declared one by its modifier,
   * or by being a getter without a setter.
   */
  private readonly(property: TS.Symbol): boolean {
    const ts = this.ts as Ts & { getCheckFlags(symbol: TS.Symbol): number };

    const flags = ts.getCheckFlags(property);

    if (flags & MAPPED) {
      return (flags & READONLY) !== 0;
    }

    const declarations = property.declarations ?? [];

    return (
      declarations.some(
        (declaration) =>
          (ts.getCombinedModifierFlags(declaration) &
            ts.ModifierFlags.Readonly) !==
          0,
      ) ||
      (declarations.some(ts.isGetAccessorDeclaration) &&
        !declarations.some(ts.isSetAccessorDeclaration))
    );
  }

  /**
   * An optional property's or tuple element's type without the
   * `undefined` its `?` already says. Under `exactOptionalPropertyTypes`,
   * which the contract is worked out with, the compiler tells that one —
   * a type of its own — from an `undefined` the property declares, which
   * stays.
   */
  private defined(type: TS.Type, path: readonly string[]): string {
    const added = (member: TS.Type) =>
      (member.flags & this.ts.TypeFlags.Undefined) !== 0 &&
      member !== this.checker.getUndefinedType();

    if (!type.isUnion()) {
      return added(type) ? "never" : this.print(type, path);
    }

    return this.union(
      type.types.filter((member) => !added(member)),
      path,
    );
  }

  print(type: TS.Type, path: readonly string[]): string {
    const { ts, checker } = this;
    const flags = type.flags;
    const F = ts.TypeFlags;

    if (flags & F.Any) {
      if ((type as { intrinsicName?: string }).intrinsicName === "error") {
        this.problem(path, "a type that did not resolve");
      }

      return "any";
    }

    if (flags & F.Unknown) return "unknown";
    if (flags & F.Never) return "never";
    if (flags & F.String) return "string";
    if (flags & F.Number) return "number";
    if (flags & F.Boolean) return "boolean";
    if (flags & F.BigInt) return "bigint";
    if (flags & F.Null) return "null";
    if (flags & F.Undefined) return "undefined";
    if (flags & F.Void) return "void";
    if (type.isStringLiteral()) return JSON.stringify(type.value);
    if (type.isNumberLiteral()) return String(type.value);
    if (flags & F.BooleanLiteral) return checker.typeToString(type);
    if (flags & F.BigIntLiteral) return checker.typeToString(type);

    if (flags & F.TemplateLiteral) {
      const { texts, types } = type as TS.TemplateLiteralType;
      const parts = types.map(
        (part, index) =>
          `\${${this.print(part, path)}}${template(texts[index + 1] ?? "")}`,
      );

      return `\`${template(texts[0] ?? "")}${parts.join("")}\``;
    }

    if (flags & F.StringMapping) {
      const mapping = type as TS.StringMappingType;

      return `${mapping.symbol.name}<${this.print(mapping.type, path)}>`;
    }

    if (flags & (F.ESSymbol | F.UniqueESSymbol)) {
      this.problem(path, "a symbol");

      return "symbol";
    }

    if (this.stream(type)) {
      return 'NonNullable<RequestInit["body"]>';
    }

    if (type.isUnion()) {
      return this.union(type.types, path);
    }

    if (type.isIntersection()) {
      return this.intersection(type.types, path);
    }

    if (flags & F.Object) {
      return this.object(type as TS.ObjectType, path);
    }

    this.problem(path, `a type it cannot write: ${checker.typeToString(type)}`);

    return "unknown";
  }

  /**
   * Whether `type` is the body of a `stream` route. A union under an alias
   * is a type of its own, so the members are compared.
   */
  private stream(type: TS.Type): boolean {
    const stream = this.known.stream;

    if (type === stream) {
      return true;
    }

    if (!type.isUnion() || !stream.isUnion()) {
      return false;
    }

    const members = new Set(stream.types);

    return (
      type.types.length === members.size &&
      type.types.every((member) => members.has(member))
    );
  }

  private union(types: readonly TS.Type[], path: readonly string[]): string {
    const printed = [
      ...new Set(types.map((member) => this.print(member, path))),
    ];
    const empty = (part: string) => part === "null" || part === "undefined";
    const parts = [
      ...printed.filter((part) => !empty(part)),
      ...printed.filter(empty),
    ];
    const both = parts.includes("true") && parts.includes("false");
    const merged = both
      ? [
          ...parts.filter((part) => part !== "true" && part !== "false"),
          "boolean",
        ]
      : parts;

    if (merged.length === 0) {
      return "never";
    }

    if (merged.length === 1 || !merged.some((part) => part.includes("\n"))) {
      return merged.join(" | ");
    }

    return merged
      .map((part) =>
        part
          .split("\n")
          .map((line, index) => (index === 0 ? `\n| ${line}` : `\n  ${line}`))
          .join(""),
      )
      .join("");
  }

  private intersection(
    types: readonly TS.Type[],
    path: readonly string[],
  ): string {
    const parts = types
      .filter((member) => !this.brand(member))
      .map((member) => this.print(member, path));

    if (parts.length === 0) {
      return "unknown";
    }

    return parts.map(grouped).join(" & ");
  }

  /** An object of nothing but properties keyed by symbols: a validator's brand. */
  private brand(type: TS.Type): boolean {
    if (!(type.flags & this.ts.TypeFlags.Object)) {
      return false;
    }

    const properties = this.checker.getPropertiesOfType(type);

    return (
      properties.length > 0 &&
      properties.every((property) =>
        property.escapedName.toString().startsWith("__@"),
      )
    );
  }

  private object(type: TS.ObjectType, path: readonly string[]): string {
    const { ts, checker } = this;

    if (type === this.known.headers) {
      this.imports.add("AnyHeaders");

      return "AnyHeaders";
    }

    const reference = type as TS.TypeReference;

    if (
      (type.objectFlags & ts.ObjectFlags.Reference) !== 0 &&
      reference.target === this.known.raw
    ) {
      this.imports.add("Raw");

      const [content] = checker.getTypeArguments(reference);

      return `Raw<${content === undefined ? "string" : this.print(content, path)}>`;
    }

    if (checker.isArrayType(type)) {
      const [element] = checker.getTypeArguments(reference);
      const printed =
        element === undefined ? "unknown" : this.print(element, path);
      const wrapped = grouped(printed);
      const readonly = reference.target.symbol?.name === "ReadonlyArray";

      return `${readonly ? "readonly " : ""}${wrapped}[]`;
    }

    if (checker.isTupleType(type)) {
      return this.tuple(reference, path);
    }

    const global = this.global(type, path);

    if (global !== undefined) {
      return global;
    }

    const name = this.names.get(type);

    if (name !== undefined) {
      return name;
    }

    if (this.open.has(type)) {
      const hoisted = this.nameOf(type);

      this.names.set(type, hoisted);

      return hoisted;
    }

    this.open.add(type);

    const body = this.body(type, path);

    this.open.delete(type);

    const recursive = this.names.get(type);

    if (recursive === undefined) {
      return body;
    }

    this.hoisted.push(
      spread(body)
        ? `export type ${recursive} = ${body};`
        : `export interface ${recursive} ${body}`,
    );

    return recursive;
  }

  private tuple(type: TS.TypeReference, path: readonly string[]): string {
    const ts = this.ts;
    const target = type.target as TS.TupleType;
    const elements = this.checker
      .getTypeArguments(type)
      .map((element, index) => {
        const flags = target.elementFlags[index] ?? ts.ElementFlags.Required;

        if (flags & ts.ElementFlags.Variable) {
          return `...${grouped(this.print(element, path))}[]`;
        }

        if (!(flags & ts.ElementFlags.Optional)) {
          return this.print(element, path);
        }

        return `${grouped(this.defined(element, path))}?`;
      });

    return `${target.readonly ? "readonly " : ""}[${elements.join(", ")}]`;
  }

  /**
   * A type the frontend knows by name: a global the DOM or ECMAScript
   * libraries declare — `Date`, `File`, `Uint8Array` — that the type is,
   * whichever declaration of it the server compiles with (Bun's `File`,
   * Node's). A global only the server has is a problem; anything else is
   * written out.
   */
  private global(
    type: TS.ObjectType,
    path: readonly string[],
  ): string | undefined {
    const { ts, checker } = this;
    const symbol = type.aliasSymbol ?? type.symbol;

    if (symbol === undefined || !this.named(symbol)) {
      return undefined;
    }

    const own = resolveName(checker, ts, symbol.name);

    if (resolveName(this.lib, ts, symbol.name) === undefined) {
      if (own !== symbol) {
        return undefined;
      }

      this.problem(path, `${symbol.name}, a global the frontend does not have`);

      return symbol.name;
    }

    if (
      own === undefined ||
      !this.same(type, checker.getDeclaredTypeOfSymbol(own))
    ) {
      return undefined;
    }

    const parameters = this.parametersOf(type);

    if (parameters.length === 0) {
      return symbol.name;
    }

    const printed = parameters.map((parameter) => {
      const text = this.print(parameter, path);

      return text.startsWith("\n") ? grouped(text) : text;
    });

    if (!printed.some((text) => text.includes("\n"))) {
      return `${symbol.name}<${printed.join(", ")}>`;
    }

    const lines = printed.map((text) =>
      text
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    );

    return `${symbol.name}<\n${lines.join(",\n")}\n>`;
  }

  /**
   * The type arguments of a generic global — `Map<string, Owner>` — each
   * printed as any other type, so that `Owner` is written out rather than
   * named where the contract does not declare it.
   */
  private parametersOf(type: TS.ObjectType): readonly TS.Type[] {
    if (type.aliasSymbol !== undefined) {
      return type.aliasTypeArguments ?? [];
    }

    if (!(type.objectFlags & this.ts.ObjectFlags.Reference)) {
      return [];
    }

    const reference = type as TS.TypeReference;
    const count = reference.target.typeParameters?.length ?? 0;

    return this.checker.getTypeArguments(reference).slice(0, count);
  }

  /** Whether `type` is the global `declared`, or an instance of it when it is generic. */
  private same(type: TS.Type, declared: TS.Type): boolean {
    const { ts, checker } = this;

    if (type === declared) {
      return true;
    }

    if (
      type.flags & ts.TypeFlags.Object &&
      (type as TS.ObjectType).objectFlags & ts.ObjectFlags.Reference &&
      (type as TS.TypeReference).target === declared
    ) {
      return true;
    }

    return (
      checker.isTypeAssignableTo(type, declared) &&
      checker.isTypeAssignableTo(declared, type)
    );
  }

  /**
   * The name of a recursive type: that of the alias or interface it came
   * from — through `Jsonify<Category>` to `Category` — or `RecursiveN`;
   * numbered when it is taken, or a global the frontend has, which the
   * interface would shadow — a tree of `File`s is `File2`.
   */
  private nameOf(type: TS.Type): string {
    const base = this.origin(type) ?? "Recursive";
    let index = 1;
    let name = base === "Recursive" ? `${base}${index}` : base;

    while (
      this.taken.has(name) ||
      resolveName(this.lib, this.ts, name) !== undefined
    ) {
      index += 1;
      name = `${base}${index}`;
    }

    this.taken.add(name);

    return name;
  }

  /**
   * Where a type came from, searched a few steps deep: the alias or the
   * interface of the application's, as opposed to the client's own
   * `Jsonify` and the mapped types it is made of, which keep what they
   * map as their type argument or as the type they take modifiers from.
   */
  private origin(type: TS.Type, depth = 0): string | undefined {
    if (depth > 4) {
      return undefined;
    }

    for (const symbol of [type.aliasSymbol, type.symbol]) {
      if (symbol !== undefined && this.named(symbol) && !this.ours(symbol)) {
        return symbol.name;
      }
    }

    const next = [
      ...(type.aliasTypeArguments ?? []),
      ...(type.isUnionOrIntersection() ? type.types : []),
      (type as { modifiersType?: TS.Type }).modifiersType,
    ];

    for (const candidate of next) {
      const found =
        candidate === undefined ? undefined : this.origin(candidate, depth + 1);

      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  }

  /**
   * Whether a symbol is a name the source gave a type, as opposed to one
   * the compiler made up: `__type` of a type literal, `__object` of an
   * object literal — a zod 4 schema with a getter.
   */
  private named(symbol: TS.Symbol): boolean {
    const F = this.ts.SymbolFlags;

    return (
      !(symbol.flags & (F.TypeLiteral | F.ObjectLiteral)) &&
      !symbol.name.startsWith("__") &&
      IDENTIFIER.test(symbol.name)
    );
  }

  /** Whether the client declares `symbol` — `Jsonify`, `Flat` and the like. */
  private ours(symbol: TS.Symbol): boolean {
    return (symbol.declarations ?? []).some((declaration) =>
      declaration.getSourceFile().fileName.startsWith(this.known.client),
    );
  }

  private problem(path: readonly string[], what: string): void {
    const place = path.length === 0 ? "" : `${path.join(" → ")}: `;

    this.problems.push(`${place}${what}`);
  }
}
