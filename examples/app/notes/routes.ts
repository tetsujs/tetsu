/**
 * The notes API: a controller over a store it is handed.
 *
 * @module
 */

import { httpError, route } from "@tetsujs/core";
import { authenticate } from "../auth.ts";
import { NewNote, Note, NoteChange, NoteId } from "./schemas.ts";
import type { NoteStore } from "./store.ts";

const signedIn = { beforeParse: [authenticate] } as const;

export class NotesController {
  constructor(private readonly notes: NoteStore) {}

  list = route({
    method: "GET",
    path: "/notes",
    hooks: signedIn,
    schema: { response: { 200: Note.array() } },
    docs: { summary: "List your notes", tags: ["notes"] },
    handler: (ctx) => this.notes.list(ctx.user.id),
  });

  get = route({
    method: "GET",
    path: "/notes/:id",
    hooks: signedIn,
    schema: { params: NoteId, response: { 200: Note } },
    docs: { summary: "Get a note", tags: ["notes"] },
    handler: (ctx) => {
      const note = this.notes.find(ctx.user.id, ctx.params.id);

      if (!note) {
        throw httpError(404, "NOTE_NOT_FOUND");
      }

      return note;
    },
  });

  create = route({
    method: "POST",
    path: "/notes",
    hooks: signedIn,
    schema: { body: NewNote, response: { 201: Note } },
    docs: { summary: "Write a note", tags: ["notes"] },
    handler: (ctx) => {
      ctx.out.status = 201;

      return this.notes.add(ctx.user.id, ctx.body);
    },
  });

  change = route({
    method: "PATCH",
    path: "/notes/:id",
    hooks: signedIn,
    schema: { params: NoteId, body: NoteChange, response: { 200: Note } },
    docs: { summary: "Edit a note", tags: ["notes"] },
    handler: (ctx) => {
      const note = this.notes.change(ctx.user.id, ctx.params.id, ctx.body);

      if (!note) {
        throw httpError(404, "NOTE_NOT_FOUND");
      }

      return note;
    },
  });

  remove = route({
    method: "DELETE",
    path: "/notes/:id",
    hooks: signedIn,
    schema: { params: NoteId, response: { 204: null } },
    docs: { summary: "Delete a note", tags: ["notes"] },
    handler: (ctx) => {
      if (!this.notes.remove(ctx.user.id, ctx.params.id)) {
        throw httpError(404, "NOTE_NOT_FOUND");
      }
    },
  });
}
