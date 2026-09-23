/**
 * Test helper: captures what the framework logs.
 *
 * The framework reports on `console.error` what it cannot report to the
 * client — an unhandled error, a handler breaking its response contract,
 * an error path that failed in turn. Tests that drive those paths on
 * purpose would otherwise print them, and a suite that prints expected
 * errors is a suite where an unexpected one goes unnoticed.
 *
 * Capturing rather than silencing: the lines stay available, so a test can
 * assert that the framework logged what it should, and logging from
 * anywhere else still reaches the terminal.
 *
 * @module
 */

import { afterEach, beforeEach, spyOn } from "bun:test";

/** The lines captured for the test that is currently running. */
export interface CapturedErrors {
  readonly lines: string[];
}

/**
 * Captures `console.error` for every test of the enclosing `describe`.
 *
 * Call it in the describe body, not inside a test: it installs the spy in
 * `beforeEach` and restores it in `afterEach`, so each test starts with an
 * empty capture and nothing leaks into the next one.
 *
 * @example
 * ```ts
 * describe("failing error mapper", () => {
 *   const errors = captureErrors();
 *
 *   test("logs what it could not answer with", async () => {
 *     await request("/circular");
 *
 *     expect(errors.lines.join("\n")).toContain("[tetsu]");
 *   });
 * });
 * ```
 */
export function captureErrors(): CapturedErrors {
  const lines: string[] = [];

  let spy: { mockRestore: () => void } | undefined;

  beforeEach(() => {
    lines.length = 0;

    spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(format).join(" "));
    });
  });

  afterEach(() => {
    spy?.mockRestore();
  });

  return { lines };
}

function format(value: unknown): string {
  return value instanceof Error
    ? `${value.name}: ${value.message}`
    : String(value);
}
