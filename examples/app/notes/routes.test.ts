/**
 * The notes API over HTTP, on a database in memory.
 *
 * @module
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { serve } from "@tetsujs/core/testing";
import { buildApp } from "../app.ts";

const request = serve(
  buildApp(new Database(":memory:"), { write: () => undefined }),
);

const as = (token: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
});

describe("notes", () => {
  test("a note is written, read back and kept from others", async () => {
    const created = await request(
      "/api/notes",
      as("ada-token", {
        method: "POST",
        body: JSON.stringify({ title: "first" }),
      }),
    );

    expect(created.status).toBe(201);

    const { id } = (await created.json()) as { id: number };

    expect((await request(`/api/notes/${id}`, as("ada-token"))).status).toBe(
      200,
    );
    expect((await request(`/api/notes/${id}`, as("grace-token"))).status).toBe(
      404,
    );
  });

  test("an unknown token is refused", async () => {
    expect((await request("/api/notes", as("nobody"))).status).toBe(401);
  });

  test("an edit changes only what it names", async () => {
    const created = await request(
      "/api/notes",
      as("ada-token", {
        method: "POST",
        body: JSON.stringify({ title: "draft", body: "kept" }),
      }),
    );
    const { id } = (await created.json()) as { id: number };

    const edited = await request(
      `/api/notes/${id}`,
      as("ada-token", {
        method: "PATCH",
        body: JSON.stringify({ title: "final" }),
      }),
    );

    expect(await edited.json()).toMatchObject({ title: "final", body: "kept" });
  });
});
