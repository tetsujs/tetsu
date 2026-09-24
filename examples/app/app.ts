/**
 * The composition root: every instance the application runs on, built
 * here once and handed to what needs it. There is no container; this file
 * is the whole of the wiring.
 *
 * `buildApp` takes the database rather than opening it, so `main.ts` opens
 * a file and the tests open one in memory — and where the access log
 * goes, so the tests can keep it out of their output.
 *
 * @module
 */

import type { Database } from "bun:sqlite";
import { createApp, group } from "@tetsujs/core";
import { docs } from "@tetsujs/openapi";
import { requestId } from "@tetsujs/request-id";
import type { AccessLogOptions } from "@tetsujs/request-log";
import { accessLog } from "@tetsujs/request-log";
import { secureHeaders } from "@tetsujs/secure-headers";
import type { User } from "./auth.ts";
import { demoTokens, Sessions } from "./auth.ts";
import { notesController } from "./notes/routes.ts";
import { NoteStore } from "./notes/store.ts";

export function buildApp(
  db: Database,
  log: AccessLogOptions = {},
  tokens: ReadonlyMap<string, User> = demoTokens,
) {
  const notes = new NoteStore(db);
  const sessions = new Sessions(tokens);
  const id = requestId();
  const logged = accessLog(log);
  const secure = secureHeaders();

  return createApp({
    hooks: {
      beforeParse: [id],
      beforeResponse: [secure],
      afterResponse: [logged],
    },
    routes: [
      group("/api", { children: [notesController({ notes, sessions })] }),
      docs({ info: { title: "Notes", version: "1.0.0" } }),
    ],
  });
}
