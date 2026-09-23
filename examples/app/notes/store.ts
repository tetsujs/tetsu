/**
 * Notes in SQLite, through `bun:sqlite`.
 *
 * Every query is scoped to an owner, so a note that belongs to someone else
 * is simply not found — the routes need no ownership check of their own.
 *
 * @module
 */

import type { Database } from "bun:sqlite";
import type { Note } from "./schemas.ts";

interface Row {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly updated_at: string;
}

function toNote(row: Row): Note {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    updatedAt: row.updated_at,
  };
}

export class NoteStore {
  constructor(private readonly db: Database) {
    db.run(`create table if not exists notes (
      id integer primary key,
      owner text not null,
      title text not null,
      body text not null,
      updated_at text not null
    )`);
  }

  list(owner: string): Note[] {
    return this.db
      .query<Row, [string]>(
        "select * from notes where owner = ? order by updated_at desc",
      )
      .all(owner)
      .map(toNote);
  }

  find(owner: string, id: number): Note | undefined {
    const row = this.db
      .query<Row, [string, number]>(
        "select * from notes where owner = ? and id = ?",
      )
      .get(owner, id);

    return row ? toNote(row) : undefined;
  }

  add(owner: string, note: { title: string; body: string }): Note {
    const row = this.db
      .query<Row, [string, string, string, string]>(
        "insert into notes (owner, title, body, updated_at) values (?, ?, ?, ?) returning *",
      )
      .get(owner, note.title, note.body, new Date().toISOString());

    return toNote(row as Row);
  }

  change(
    owner: string,
    id: number,
    change: { title?: string | undefined; body?: string | undefined },
  ): Note | undefined {
    const current = this.find(owner, id);

    if (!current) {
      return undefined;
    }

    const row = this.db
      .query<Row, [string, string, string, string, number]>(
        "update notes set title = ?, body = ?, updated_at = ? where owner = ? and id = ? returning *",
      )
      .get(
        change.title ?? current.title,
        change.body ?? current.body,
        new Date().toISOString(),
        owner,
        id,
      );

    return row ? toNote(row) : undefined;
  }

  remove(owner: string, id: number): boolean {
    return (
      this.db
        .query<unknown, [string, number]>(
          "delete from notes where owner = ? and id = ?",
        )
        .run(owner, id).changes > 0
    );
  }
}
