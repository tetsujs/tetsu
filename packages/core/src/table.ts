/**
 * Route table compilation.
 *
 * Walks the topology tree once at startup and produces a flat table: every
 * route with its full path (group prefixes joined), its complete hook
 * chains and the name of its controller for diagnostics.
 *
 * Chains run outermost-first — app → outer groups → inner groups → route —
 * except `onError`, which runs innermost-first so that the most specific
 * handler gets to map an error before more general ones.
 *
 * Startup is where topology mistakes fail: a duplicate `method + path`
 * throws naming both controllers, and so do two paths that differ only in
 * parameter names — Bun's router sees one pattern there, and the later
 * registration would silently shadow the earlier one. A controller without
 * a single route produces a warning.
 *
 * Internal to the core: `createApp()` builds the table, the pipeline
 * consumes its precomputed chains.
 *
 * @module
 */

import type { BodyType, RouteInfo, SchemaConfig } from "./context.ts";
import type { GroupHooks, GroupNode } from "./group.ts";
import { isGroup } from "./group.ts";
import type { AnyHook, SlotName } from "./hook.ts";
import { slotNames } from "./hook.ts";
import type { Mountable } from "./mount.ts";
import { isApp, isMountable } from "./mount.ts";
import type { MergedHooks } from "./pipeline.ts";
import type { Method, RouteDef } from "./route.ts";
import { isRoute } from "./route.ts";
import type { HooksConfig } from "./stack.ts";
import type { WsDef } from "./ws.ts";
import { isWs, upgradeHandler } from "./ws.ts";

/**
 * One row of the compiled route table — the public diagnostics surface.
 *
 * Exposed as `app.entries` for tooling: route listings, OpenAPI
 * generation, startup diagnostics. The row is stable public API; the
 * table-building machinery around it is not.
 */
export interface RouteTableEntry {
  readonly method: Method;

  /** Full path: group prefixes joined with the route's own path. */
  readonly path: string;

  readonly def: RouteDef;

  /** Precomputed hook chains in execution order. */
  readonly hooks: MergedHooks;

  /** Constructor name of the owning controller, for diagnostics. */
  readonly controller: string;

  /**
   * What a request matching this entry sees as `ctx.route`.
   *
   * The same facts as the fields around it, in the shape the core is
   * willing to hand to application code: no `def`, no `hooks`. Built once
   * here rather than per request — every request that matches this entry
   * gets this very object.
   */
  readonly route: RouteInfo;

  /**
   * The socket endpoint this entry serves, when it is one.
   *
   * A handshake is a `GET` and occupies that slot of its path like any
   * other route, so tooling that walks the table sees it — and sees, by
   * this field, that it answers a socket rather than a body.
   */
  readonly ws?: WsDef;

  /**
   * The controller field the route was declared as — `"setAvatar"` for
   * `setAvatar = route({...})`.
   *
   * The stable, author-given name of an endpoint, which nothing else in
   * the table carries: a documentation generator turns it into an
   * `operationId`, and a diagnostic points at the source with it. Absent
   * for a `RouteDef` mounted standalone, which has no field to be named
   * by.
   */
  readonly name?: string;
}

/**
 * The result of compiling a topology tree.
 */
export interface RouteTable {
  readonly entries: readonly RouteTableEntry[];

  /**
   * Application-level chains alone, without any group or route hooks.
   *
   * Protocol responses — `404`, `405`, `OPTIONS` — run through these, so
   * app-wide observers and CORS see requests that matched no handler while
   * zone guards never run on a preflight.
   */
  readonly appHooks: MergedHooks;

  /** Non-fatal findings, e.g. a controller without routes. */
  readonly warnings: readonly string[];

  /**
   * The mounted controllers waiting for the application, in the order the
   * walk found them — deduplicated, because one instance mounted under two
   * prefixes is still one controller.
   */
  readonly mounted: readonly Mountable[];
}

/**
 * One route as the application's type remembers it.
 *
 * What a generated client, or any other consumer of `app.routes`, needs to
 * call an endpoint: which method and full path it answers, and the schemas
 * that decide what may be sent and what comes back.
 */
export interface RouteSignature {
  readonly method: Method;
  readonly path: string;
  readonly schema: SchemaConfig;
  readonly bodyType: BodyType | undefined;
}

/** Every route of an application, keyed by `"METHOD /full/path"`. */
export type RouteMap = Record<string, RouteSignature>;

/**
 * Walks a topology at the type level, exactly as `walk()` walks it at
 * runtime.
 *
 * Arrays and groups recurse — a group joining its prefix onto everything
 * below it, the same join `joinPath` performs — a route contributes itself,
 * and anything else is read as a controller: the fields that are routes
 * count, the fields that are not resolve to `never` and vanish from the
 * union. Socket endpoints are absent by construction: a `ws()` declaration
 * is not a `RouteDef`, and nothing calls a handshake like a route.
 *
 * Internal to the core: `createApp()` applies it, and its result is what
 * `App` carries.
 */
type Signatures<
  Node,
  Prefix extends string = "",
> = Node extends readonly unknown[]
  ? Signatures<Node[number], Prefix>
  : Node extends GroupNode<infer P, infer Children>
    ? Signatures<Children[number], `${Prefix}${P}`>
    : Node extends RouteDef<
          infer P,
          infer S,
          infer _H,
          infer B,
          infer M,
          infer _R
        >
      ? Entry<M, `${Prefix}${P}`, S, B>
      : Node extends object
        ? {
            [K in keyof Node]: Node[K] extends RouteDef<
              infer P,
              infer S,
              infer _H,
              infer B,
              infer M,
              infer _R
            >
              ? Entry<M, `${Prefix}${P}`, S, B>
              : never;
          }[keyof Node]
        : never;

type Entry<
  M extends Method,
  P extends string,
  S extends SchemaConfig,
  B extends BodyType | undefined,
> = {
  readonly key: `${M} ${P}`;
  readonly method: M;
  readonly path: P;
  readonly schema: S;
  readonly bodyType: B;
};

/**
 * The route map of a topology: what {@link Signatures} found, keyed by
 * method and path.
 */
export type RoutesOf<Node> = MapOf<Signatures<Node>>;

/**
 * Keys the entries by their `key` field.
 *
 * Remaps the union in one pass (`[Entry in E as Entry["key"]]`) rather than
 * looking each key up with `Extract`: the lookup compares every key against
 * every entry, which is quadratic and hits the compiler's instantiation
 * limit on a large application — measured at 1600 routes.
 */
type MapOf<E extends { readonly key: string }> = {
  readonly [Entry in E as Entry["key"]]: Omit<Entry, "key">;
};

const emptyChains: MergedHooks = {
  beforeParse: [],
  beforeValidation: [],
  beforeHandle: [],
  beforeResponse: [],
  afterResponse: [],
  onError: [],
};

/**
 * Compiles a topology tree into a flat route table.
 *
 * Accepts a single group, a single controller or an array of either.
 * A `RouteDef` passed directly as a child is registered standalone.
 */
export function buildRouteTable(input: {
  readonly hooks?: GroupHooks | undefined;
  readonly routes: object | readonly object[];
}): RouteTable {
  const entries: RouteTableEntry[] = [];
  const warnings: string[] = [];
  const mounted = new Set<Mountable>();
  const seen = new Map<string, RouteTableEntry>();
  const shapes = new Map<string, RouteTableEntry>();

  /**
   * Puts one route into the table, with the path and chains it ended up
   * with, and refuses the two topology mistakes that only the whole table
   * can see: the same `method + path` twice, and two paths that differ
   * only in the names of their parameters.
   */
  const register = (
    def: RouteDef,
    prefix: string,
    chains: MergedHooks,
    controller: string,
    name?: string,
    socket?: WsDef,
  ): void => {
    const path = joinPath(prefix, def.path);
    const key = `${def.method} ${path}`;
    const existing = seen.get(key);

    if (existing) {
      throw new Error(
        `Duplicate route: ${key} is defined by both "${existing.controller}" and "${controller}"`,
      );
    }

    const shape = pathShape(path);
    const shadowed = shapes.get(shape);

    if (shadowed && shadowed.path !== path) {
      throw new Error(
        `Conflicting routes: "${shadowed.path}" from "${shadowed.controller}" and "${path}" from "${controller}" differ only in parameter names — Bun's router matches them as one pattern, so the later one shadows the earlier. Name the parameter the same in both.`,
      );
    }

    const entry: RouteTableEntry = {
      method: def.method,
      path,
      def,
      hooks: appendChains(chains, def.hooks),
      controller,
      route: {
        method: def.method,
        path,
        controller,
        ...(name === undefined ? {} : { name }),
      },
      ...(name === undefined ? {} : { name }),
      ...(socket === undefined ? {} : { ws: socket }),
    };

    seen.set(key, entry);
    shapes.set(shape, entry);
    entries.push(entry);
  };

  /**
   * Registers a socket endpoint as the `GET` of its path.
   *
   * A handshake is a `GET`, so it takes that slot and collides with a
   * route declaring the same one — which is the truth: a path answers
   * either a socket or a body, never both.
   */
  const registerSocket = (
    def: WsDef,
    prefix: string,
    chains: MergedHooks,
    controller: string,
    name?: string,
  ): void => {
    register(
      {
        method: "GET",
        path: def.path,
        schema: def.schema,
        hooks: def.hooks,
        handler: upgradeHandler(def),
      } as unknown as RouteDef,
      prefix,
      chains,
      controller,
      name,
      def,
    );
  };

  /**
   * Descends one node of the topology, carrying down the prefix and the
   * chains accumulated so far.
   *
   * Everything a controller might be is decided here, in the order that
   * makes the diagnostics useful: arrays and groups recurse, routes and
   * socket endpoints register, a class passed instead of an instance and
   * an application passed as a child get their own messages, and anything
   * else is treated as a controller — an object whose fields are read for
   * routes.
   */
  const walk = (
    node: object | readonly object[],
    prefix: string,
    chains: MergedHooks,
  ): void => {
    if (Array.isArray(node)) {
      for (const child of node) {
        walk(child as object, prefix, chains);
      }

      return;
    }

    if (isGroup(node)) {
      walk(
        node.children,
        prefix + node.prefix,
        appendChains(chains, node.hooks),
      );

      return;
    }

    if (isRoute(node)) {
      register(node, prefix, chains, "(standalone)");

      return;
    }

    if (isWs(node)) {
      registerSocket(node, prefix, chains, "(standalone)");

      return;
    }

    if (typeof node === "function") {
      throw new Error(
        `Mount a controller instance, not the class itself: use "new ${(node as { name?: string }).name ?? "Controller"}(...)"`,
      );
    }

    if (isApp(node)) {
      throw new Error(
        "An application cannot be mounted as a child; mount its controllers, or serve it separately",
      );
    }

    if (isMountable(node)) {
      mounted.add(node);
    }

    const fields = Object.entries(node).filter(
      ([, value]) => isRoute(value) || isWs(value),
    );

    const controller = node.constructor?.name ?? "Object";

    assertNoRouteAccessors(node, controller);

    if (fields.length === 0) {
      if (!isMountable(node)) {
        warnings.push(
          `Controller "${controller}" defines no routes — did you forget route()?`,
        );
      }

      return;
    }

    for (const [name, def] of fields) {
      if (isWs(def)) {
        registerSocket(def, prefix, chains, controller, name);
      } else {
        register(def as RouteDef, prefix, chains, controller, name);
      }
    }
  };

  const appHooks = appendChains(emptyChains, input.hooks);

  walk(input.routes, "", appHooks);

  return { entries, appHooks, warnings, mounted: [...mounted] };
}

/**
 * Refuses a route declared as a getter in a class body.
 *
 * Routes are collected with `Object.entries`, which sees a controller's own
 * enumerable properties — a field, and equally a getter written in an
 * object literal, which is own and enumerable and gets invoked. A `get` in
 * a class body is neither: it lives on the prototype, so the route never
 * reaches the table — while `RoutesOf` walks `keyof` and cannot tell an
 * accessor from a property, and puts it in the application's type. The
 * endpoint ends up typed, documented and absent, and the only symptom is a
 * `404` on a path the compiler agreed existed.
 *
 * Types cannot express the difference, so it is caught here instead: at
 * startup, like every other shape a path or a table is not allowed to have.
 *
 * Reading the getter is the only way to learn what it returns. One that
 * throws is left alone — its failure is not this function's to report —
 * and the rest cost one call each, at startup, on objects that are data.
 */
function assertNoRouteAccessors(node: object, controller: string): void {
  for (
    let level = Object.getPrototypeOf(node) as object | null;
    level !== null && level !== Object.prototype;
    level = Object.getPrototypeOf(level) as object | null
  ) {
    for (const [name, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(level),
    )) {
      if (!descriptor.get) {
        continue;
      }

      let value: unknown;

      try {
        value = descriptor.get.call(node);
      } catch {
        continue;
      }

      if (isRoute(value) || isWs(value)) {
        throw new Error(
          `Controller "${controller}" declares "${name}" with "get", and a route must be a field: routes are read from the controller's own properties, so a getter on the class prototype is typed into the application but never served`,
        );
      }
    }
  }
}

/**
 * Erases parameter names, leaving the pattern Bun's router actually
 * matches: `/users/:id` and `/users/:userId` are one and the same to it.
 */
function pathShape(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? ":" : segment))
    .join("/");
}

function joinPath(prefix: string, path: string): string {
  if (prefix === "") {
    return path;
  }

  if (path === "/") {
    return prefix;
  }

  return prefix + path;
}

function appendChains(
  base: MergedHooks,
  extra: GroupHooks | HooksConfig | undefined,
): MergedHooks {
  if (!extra) {
    return base;
  }

  const merged = { ...base } as { [K in SlotName]: readonly AnyHook[] };

  for (const slot of slotNames) {
    const added = extra[slot];

    if (added && added.length > 0) {
      merged[slot] =
        slot === "onError"
          ? [...added, ...base[slot]]
          : [...base[slot], ...added];
    }
  }

  return merged;
}
