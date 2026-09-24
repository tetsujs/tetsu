/**
 * How the framework and the objects it is handed recognise each other.
 *
 * Both symbols here are registered globally, so two copies of the core in
 * one dependency tree still recognise each other's objects. `onMount` is
 * the one thing a controller may ask the framework for: the application it
 * was mounted in.
 *
 * A controller is data, and the application is built from that data, so a
 * controller that wants to describe the application — documentation, a
 * route listing, a metrics registry enumerating endpoints — cannot receive
 * it in its constructor: the application does not exist yet. `createApp`
 * closes the loop by handing the built application to every mounted
 * controller that declares {@link onMount}, once, before it returns.
 *
 * @module
 */

import type { App } from "./app.ts";

/**
 * The method a controller declares to be handed the built application.
 *
 * A symbol rather than a name like `use` or `init`: a controller is any
 * object with route fields, so a plain method name would collide with
 * whatever the author already calls their own — and a collision here would
 * silently call something that was never meant for the framework.
 *
 * Registered globally (`Symbol.for`), so two copies of the core in one
 * dependency tree still recognize each other's controllers.
 */
export const onMount: unique symbol = Symbol.for("tetsu.onMount");

/**
 * Marks a built application, so it can be told from a controller.
 *
 * The check that needed this — the one refusing an application passed
 * where a controller belongs — used to read the names `routes` and `fetch`
 * off the object instead, and turned away a controller that happened to
 * have both, or that inherited them from a base class, with a message
 * about something it had not done. A symbol has no such collisions, which
 * is the same reason `onMount` is one rather than a name like `use`.
 */
export const appBrand: unique symbol = Symbol.for("tetsu.app");

/**
 * A controller that receives the application it was mounted in.
 *
 * @example A controller that answers with the routes of its application
 * ```ts
 * export const routesController = controller("Routes", () => {
 *   let mounted: App | undefined;
 *
 *   return {
 *     [onMount]: (app: App) => {
 *       mounted = app;
 *     },
 *     list: route({
 *       method: "GET",
 *       path: "/routes",
 *       handler: () => mounted?.entries.map((entry) => entry.path) ?? [],
 *     }),
 *   };
 * });
 * ```
 */
export interface Mountable {
  [onMount](app: App): void;
}

/** Whether a controller asks for the application. */
export function isMountable(node: object): node is Mountable {
  return typeof (node as Partial<Mountable>)[onMount] === "function";
}

/** Whether a value is a built application rather than a controller. */
export function isApp(value: unknown): boolean {
  return typeof value === "object" && value !== null && appBrand in value;
}
