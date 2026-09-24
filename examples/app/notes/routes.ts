/**
 * The notes API: a controller over a store and the sessions it is handed.
 *
 * The authentication hook is built here, from the sessions, next to the
 * routes that mount it — `main.ts` wires services, not hooks.
 *
 * @module
 */

import { controller, httpError, route } from "@tetsujs/core";
import type { Sessions } from "../auth.ts";
import { authenticate } from "../auth.ts";
import { NewNote, Note, NoteChange, NoteId } from "./schemas.ts";
import type { NoteStore } from "./store.ts";

export interface NotesDeps {
  readonly notes: NoteStore;
  readonly sessions: Sessions;
}

export const notesController = controller(
  "Notes",
  ({ notes, sessions }: NotesDeps) => {
    const signedIn = { beforeParse: [authenticate(sessions)] } as const;

    return {
      list: route({
        method: "GET",
        path: "/notes",
        hooks: signedIn,
        schema: { response: { 200: Note.array() } },
        docs: { summary: "List your notes", tags: ["notes"] },
        handler: (ctx) => notes.list(ctx.user.id),
      }),

      get: route({
        method: "GET",
        path: "/notes/:id",
        hooks: signedIn,
        schema: { params: NoteId, response: { 200: Note } },
        docs: { summary: "Get a note", tags: ["notes"] },
        handler: (ctx) => {
          const note = notes.find(ctx.user.id, ctx.params.id);

          if (!note) {
            throw httpError(404, "NOTE_NOT_FOUND");
          }

          return note;
        },
      }),

      create: route({
        method: "POST",
        path: "/notes",
        hooks: signedIn,
        schema: { body: NewNote, response: { 201: Note } },
        docs: { summary: "Write a note", tags: ["notes"] },
        handler: (ctx) => {
          ctx.out.status = 201;

          return notes.add(ctx.user.id, ctx.body);
        },
      }),

      change: route({
        method: "PATCH",
        path: "/notes/:id",
        hooks: signedIn,
        schema: { params: NoteId, body: NoteChange, response: { 200: Note } },
        docs: { summary: "Edit a note", tags: ["notes"] },
        handler: (ctx) => {
          const note = notes.change(ctx.user.id, ctx.params.id, ctx.body);

          if (!note) {
            throw httpError(404, "NOTE_NOT_FOUND");
          }

          return note;
        },
      }),

      remove: route({
        method: "DELETE",
        path: "/notes/:id",
        hooks: signedIn,
        schema: { params: NoteId, response: { 204: null } },
        docs: { summary: "Delete a note", tags: ["notes"] },
        handler: (ctx) => {
          if (!notes.remove(ctx.user.id, ctx.params.id)) {
            throw httpError(404, "NOTE_NOT_FOUND");
          }
        },
      }),
    };
  },
);
