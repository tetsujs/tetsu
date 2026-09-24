/**
 * Topology grouping — the tree the application mounts routes from.
 *
 * A group is a node carrying a path prefix, zone-wide hooks and children
 * (controllers or nested groups). The whole API topology — prefixes,
 * protected zones, hook order — lives in one place: the composition root.
 *
 * Groups deliberately do not compose controllers into controllers; nesting
 * happens only here.
 *
 * @module
 */

import type { ValidatePrefix } from "./path.ts";
import type {
  GroupHooksInput,
  HooksConfig,
  ValidateGroupHooksInput,
} from "./stack.ts";

/**
 * Hooks attached to a group (or the application), keyed by lifecycle slot.
 *
 * Where the config is passed (`group()`, `createApp()`), two things are
 * enforced per hook: its slot — a `beforeHandle` hook cannot be placed into
 * the `beforeParse` tuple — and its context requirement, which may not
 * exceed what the slot guarantees plus what the hooks before it at the
 * same level contributed. A group does not know which routes it will
 * contain, so it cannot satisfy a hook that asks for a validated field or
 * a route hook's extension; such a hook is rejected at compile time
 * instead of throwing on the first request.
 *
 * Context extensions of group hooks do not reach handler types. Group
 * hooks are for transparent work (metrics, logging, CORS) and guards
 * (verify and throw); typed context always comes from the route's own
 * hooks.
 *
 * Group hooks run only for requests that reached a route of the group.
 * Protocol responses — `404`, `405`, an `OPTIONS` preflight — run with the
 * application-level chains alone, so answering a zone's preflight or rate
 * limiting a zone's `404` flood belongs to the application hooks — a
 * deliberate trade-off, and the reason `@tetsujs/cors` says to mount it
 * on the application rather than on a group.
 */
export type GroupHooks = HooksConfig;

/**
 * The configuration accepted by `group()`.
 */
export interface GroupConfig<H extends GroupHooksInput = GroupHooks> {
  /** Zone-wide hooks, keyed by slot; see `GroupHooks` for what belongs here. */
  readonly hooks?: H & ValidateGroupHooksInput<H>;

  /** Controllers and nested groups mounted under this prefix. */
  readonly children: readonly object[];
}

const groupBrand: unique symbol = Symbol("tetsu.group");

/**
 * A node of the topology tree: prefix, zone hooks and children.
 */
export interface GroupNode<
  Prefix extends string = string,
  Children extends readonly object[] = readonly object[],
> {
  readonly [groupBrand]: true;

  /**
   * The prefix mounted on, as a literal.
   *
   * Kept rather than widened for the same reason a route keeps its method:
   * the paths an application serves are the prefix joined with what its
   * children declare, and that join happens in the types too.
   */
  readonly prefix: Prefix;

  readonly hooks?: GroupHooks | undefined;

  /** What is mounted under it, with the types it was written with. */
  readonly children: Children;
}

/**
 * Creates a topology node mounting its children under a path prefix.
 *
 * The prefix must start with `"/"`, must not end with one, must not be bare
 * `"/"` and must not declare `:params`; violations are compile errors on a
 * literal and throw otherwise — topology mistakes should fail at startup,
 * not at request time.
 *
 * @example
 * ```ts
 * const app = createApp({
 *   routes: group("/api/v1", {
 *     children: [
 *       usersController({ users }),
 *       group("/admin", {
 *         hooks: { beforeParse: [requireAdmin] },
 *         children: [adminController({ admin })],
 *       }),
 *     ],
 *   }),
 * });
 * ```
 */
export function group<
  const Prefix extends string,
  const C extends readonly object[] = readonly object[],
  const H extends GroupHooksInput = GroupHooks,
>(
  prefix: Prefix & ValidatePrefix<Prefix>,
  config: GroupConfig<H> & { readonly children: C },
): GroupNode<Prefix, C> {
  if (!prefix.startsWith("/")) {
    throw new Error(`Group prefix must start with "/", got "${prefix}"`);
  }

  if (prefix === "/") {
    throw new Error(
      'Group prefix "/" is a no-op — mount the children directly instead',
    );
  }

  if (prefix.endsWith("/")) {
    throw new Error(`Group prefix must not end with "/", got "${prefix}"`);
  }

  if (prefix.includes("//")) {
    throw new Error(
      `Group prefix must not contain empty segments ("//"), got "${prefix}"`,
    );
  }

  if (prefix.includes(":")) {
    throw new Error(
      `Group prefix must not declare ":params" — a controller is typed where it is written, not where it is mounted; got "${prefix}"`,
    );
  }

  if (prefix.includes("*")) {
    throw new Error(
      `Group prefix must not contain "*" — a wildcard inside a joined path never matches in Bun's router; got "${prefix}"`,
    );
  }

  return {
    [groupBrand]: true,
    prefix,
    hooks: slotHooks(config.hooks, `group("${prefix}")`),
    children: config.children,
  };
}

/**
 * Tells whether a value is a `GroupNode` — used by the application while
 * walking the topology tree.
 */
export function isGroup(value: unknown): value is GroupNode {
  return typeof value === "object" && value !== null && groupBrand in value;
}

/**
 * Takes a level's `hooks` as the table reads them: the object keyed by
 * slot.
 *
 * A list is the form before 0.3.0, and JavaScript would pass it through
 * silently — its elements are keyed `0`, `1`, and no slot of the table
 * would find them — so every hook in it would quietly stop running. The
 * compiler refuses a list too; this is for the code it does not see.
 * Internal to the core.
 */
export function slotHooks(
  hooks: GroupHooksInput | undefined,
  where: string,
): GroupHooks | undefined {
  if (Array.isArray(hooks)) {
    throw new Error(
      `${where}: hooks is an object keyed by slot, not a list — write { beforeParse: [a, b], afterResponse: [c] }`,
    );
  }

  return hooks as GroupHooks | undefined;
}
