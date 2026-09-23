/**
 * The shapes of the notes API, in and out.
 *
 * @module
 */

import { z } from "zod";

export const NoteId = z.object({ id: z.coerce.number().int().positive() });

export const NewNote = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(10_000).default(""),
});

/**
 * What an edit may change — each field optional and without a default, so
 * a field the edit leaves out stays as it was. `NewNote.partial()` would
 * keep `body`'s default and blank the body of every edit that omits it.
 */
export const NoteChange = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(10_000).optional(),
});

export const Note = z.object({
  id: z.number().int(),
  title: z.string(),
  body: z.string(),
  updatedAt: z.string(),
});

export type Note = z.infer<typeof Note>;
