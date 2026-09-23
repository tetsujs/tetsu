/**
 * A controller written to be tested — see `todos.test.ts`.
 *
 * The store is handed in through the constructor, so a test can hand in
 * another one: that is the whole of dependency injection here. The default
 * export wires the real one.
 *
 * ```sh
 * bun test examples/todos.test.ts
 * ```
 *
 * @module
 */

import { createApp, httpError, route } from "@tetsujs/core";
import { z } from "zod";

export interface Todo {
  readonly id: number;
  readonly title: string;
  readonly done: boolean;
}

export interface TodoStore {
  find(id: number): Todo | undefined;
  add(title: string): Todo;
}

export class MemoryTodoStore implements TodoStore {
  private readonly todos = new Map<number, Todo>();

  find(id: number): Todo | undefined {
    return this.todos.get(id);
  }

  add(title: string): Todo {
    const todo = { id: this.todos.size + 1, title, done: false };

    this.todos.set(todo.id, todo);

    return todo;
  }
}

const TodoId = z.object({ id: z.coerce.number().int().positive() });

const NewTodo = z.object({ title: z.string().min(1) });

export class TodosController {
  constructor(private readonly store: TodoStore) {}

  get = route({
    method: "GET",
    path: "/todos/:id",
    schema: { params: TodoId },
    handler: (ctx) => {
      const todo = this.store.find(ctx.params.id);

      if (!todo) {
        throw httpError(404, "TODO_NOT_FOUND");
      }

      return todo;
    },
  });

  create = route({
    method: "POST",
    path: "/todos",
    schema: { body: NewTodo },
    handler: (ctx) => {
      ctx.out.status = 201;

      return this.store.add(ctx.body.title);
    },
  });
}

export default createApp({
  routes: new TodosController(new MemoryTodoStore()),
});
