/**
 * Type-level tests of the TanStack Query options: what React Query,
 * Svelte Query and the other adapters infer from them — data, a narrowing
 * error, mutation variables, infinite pages — and what a typed key gives
 * the query client.
 *
 * @module
 */

import type { InfiniteData } from "@tanstack/react-query";
import {
  MutationObserver,
  QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  useInfiniteQuery as useSolidInfiniteQuery,
  useMutation as useSolidMutation,
  useQuery as useSolidQuery,
} from "@tanstack/solid-query";
import {
  createInfiniteQuery,
  createMutation,
  createQuery,
} from "@tanstack/svelte-query";
import {
  useInfiniteQuery as useVueInfiniteQuery,
  useMutation as useVueMutation,
  useQuery as useVueQuery,
} from "@tanstack/vue-query";
import { createApp, route } from "@tetsujs/core";
import { computed, ref } from "vue";
import { mockSchema } from "../../core/test-utils/mock-schema.ts";
import type { Equal } from "../../core/test-utils/types.ts";
import type { AnyHeaders } from "./index.ts";
import { createClient } from "./index.ts";
import type { QueryUtils } from "./tanstack.ts";
import { queryUtils } from "./tanstack.ts";

/** Holds `T` to be `true` where a type alias would go unused: in a narrowed branch. */
declare function check<T extends true>(): void;

interface User {
  id: number;
  name: string;
  createdAt: string;
}

interface Page {
  items: User[];
  next: number | null;
}

interface Api {
  readonly "GET /users/:id": {
    readonly request: {
      readonly params: { id: number };
      readonly headers?: AnyHeaders;
    };
    readonly responses: {
      readonly 200: User;
      readonly 404: { status: 404; error: "USER_NOT_FOUND"; message: string };
    };
  };
  readonly "GET /users": {
    readonly request: {
      readonly query?: { page?: number; role?: "admin" | "user" };
      readonly headers?: AnyHeaders;
    };
    readonly responses: { readonly 200: Page };
  };
  readonly "POST /users": {
    readonly request: {
      readonly body: { name: string };
      readonly headers?: AnyHeaders;
    };
    readonly responses: {
      readonly 201: User;
      readonly 409: { status: 409; error: "NAME_TAKEN"; message: string };
    };
  };
  readonly "DELETE /users/:id": {
    readonly request: {
      readonly params: { id: number };
      readonly headers?: AnyHeaders;
    };
    readonly responses: { readonly 204: undefined };
  };
  readonly "POST /sessions/refresh": {
    readonly request: { readonly headers?: AnyHeaders };
    readonly responses: { readonly 200: { token: string } };
  };
  readonly "GET /me": {
    readonly request: {
      readonly headers: { authorization: string } & AnyHeaders;
    };
    readonly responses: { readonly 200: User };
  };
}

const q = queryUtils(createClient<Api>());
const queryClient = new QueryClient();

export function React() {
  const user = useQuery(
    q.get("/users/:id").queryOptions({ params: { id: 1 } }),
  );

  check<Equal<typeof user.data, User | undefined>>();

  if (user.error) {
    user.error.status satisfies number;

    if (user.error.status === 404) {
      const code = user.error.body.error;

      check<Equal<typeof code, "USER_NOT_FOUND">>();
    }
  }

  const create = useMutation({
    ...q.post("/users").mutationOptions(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: q.get("/users/:id").key() }),
  });

  create.mutate({ body: { name: "a" } });

  // @ts-expect-error the body is required
  create.mutate({});

  // @ts-expect-error the body is required
  create.mutate();

  check<Equal<typeof create.data, User | undefined>>();

  if (create.error?.status === 409) {
    const code = create.error.body.error;

    check<Equal<typeof code, "NAME_TAKEN">>();
  }

  const refresh = useMutation(q.post("/sessions/refresh").mutationOptions());

  refresh.mutate();
  void refresh.mutateAsync();
  void new MutationObserver(
    queryClient,
    q.post("/sessions/refresh").mutationOptions(),
  ).mutate();

  const remove = useMutation(q.delete("/users/:id").mutationOptions());

  remove.mutate({ params: { id: 1 } });
  check<Equal<typeof remove.data, undefined>>();

  const pages = useInfiniteQuery(
    q.get("/users").infiniteOptions({
      input: (page) => ({ query: { page } }),
      initialPageParam: 1,
      getNextPageParam: (last) => {
        check<Equal<typeof last, Page>>();

        return last.next;
      },
    }),
  );

  check<Equal<typeof pages.data, InfiniteData<Page> | undefined>>();

  const thrown = useQuery({
    ...q.get("/users/:id").queryOptions({ params: { id: 1 } }),
    throwOnError: true,
  });

  if (thrown.error?.status === 404) {
    const code = thrown.error.body.error;

    check<Equal<typeof code, "USER_NOT_FOUND">>();
  }

  useQuery({
    ...q.get("/users/:id").queryOptions({ params: { id: 1 } }),
    throwOnError: (error) => error.status >= 500,
  });

  const suspended = useSuspenseQuery(
    q.get("/users/:id").queryOptions({ params: { id: 1 } }),
  );

  check<Equal<typeof suspended.data, User>>();

  if (suspended.error?.status === 404) {
    const code = suspended.error.body.error;

    check<Equal<typeof code, "USER_NOT_FOUND">>();
  }

  const retried = useQuery({
    ...q.get("/users/:id").queryOptions({ params: { id: 1 } }),
    retry: (count, error) => error.status >= 500 && count < 3,
  });

  if (retried.error?.status === 404) {
    const code = retried.error.body.error;

    check<Equal<typeof code, "USER_NOT_FOUND">>();
  }

  return null;
}

export function Svelte() {
  const user = createQuery(() =>
    q.get("/users/:id").queryOptions({ params: { id: 1 } }),
  );

  check<Equal<typeof user.data, User | undefined>>();

  if (user.error?.status === 404) {
    const code = user.error.body.error;

    check<Equal<typeof code, "USER_NOT_FOUND">>();
  }

  const create = createMutation(() => q.post("/users").mutationOptions());

  const thrown = createQuery(() => ({
    ...q.get("/users/:id").queryOptions({ params: { id: 1 } }),
    throwOnError: true,
  }));

  if (thrown.error?.status === 404) {
    const code = thrown.error.body.error;

    check<Equal<typeof code, "USER_NOT_FOUND">>();
  }

  create.mutate({ body: { name: "a" } });

  if (create.error?.status === 409) {
    const code = create.error.body.error;

    check<Equal<typeof code, "NAME_TAKEN">>();
  }

  const pages = createInfiniteQuery(() =>
    q.get("/users").infiniteOptions({
      input: (page) => ({ query: { page } }),
      initialPageParam: 1,
      getNextPageParam: (last) => last.next,
    }),
  );

  check<Equal<typeof pages.data, InfiniteData<Page> | undefined>>();
}

export function Vue() {
  const id = ref(1);
  const user = useVueQuery(
    computed(() =>
      q.get("/users/:id").queryOptions({ params: { id: id.value } }),
    ),
  );

  check<Equal<typeof user.data.value, User | undefined>>();

  const error = user.error.value;

  if (error?.status === 404) {
    const code = error.body.error;

    check<Equal<typeof code, "USER_NOT_FOUND">>();
  }

  const plain = useVueQuery(
    q.get("/users/:id").queryOptions({ params: { id: 1 } }),
  );

  check<Equal<typeof plain.data.value, User | undefined>>();

  const create = useVueMutation(q.post("/users").mutationOptions());

  create.mutate({ body: { name: "a" } });

  // @ts-expect-error the body needs a name
  create.mutate({ body: {} });

  const failed = create.error.value;

  if (failed?.status === 409) {
    const code = failed.body.error;

    check<Equal<typeof code, "NAME_TAKEN">>();
  }

  const pages = useVueInfiniteQuery(
    q.get("/users").infiniteOptions({
      input: (page) => ({ query: { page } }),
      initialPageParam: 1,
      getNextPageParam: (last) => last.next,
    }),
  );

  check<Equal<typeof pages.data.value, InfiniteData<Page> | undefined>>();
}

export function Solid() {
  const user = useSolidQuery(() =>
    q.get("/users/:id").queryOptions({ params: { id: 1 } }),
  );

  check<Equal<typeof user.data, User | undefined>>();

  if (user.error?.status === 404) {
    const code = user.error.body.error;

    check<Equal<typeof code, "USER_NOT_FOUND">>();
  }

  const create = useSolidMutation(() => q.post("/users").mutationOptions());

  create.mutate({ body: { name: "a" } });

  // @ts-expect-error the body needs a name
  create.mutate({ body: {} });

  if (create.error?.status === 409) {
    const code = create.error.body.error;

    check<Equal<typeof code, "NAME_TAKEN">>();
  }

  const pages = useSolidInfiniteQuery(() =>
    q.get("/users").infiniteOptions({
      input: (page) => ({ query: { page } }),
      initialPageParam: 1,
      getNextPageParam: (last) => last.next,
    }),
  );

  check<Equal<typeof pages.data, InfiniteData<Page> | undefined>>();
}

export async function Keys() {
  const options = q.get("/users/:id").queryOptions({ params: { id: 1 } });

  await queryClient.prefetchQuery(options);

  const fetched = await queryClient.query(options);

  check<Equal<typeof fetched, User>>();

  const cached = queryClient.getQueryData(options.queryKey);

  check<Equal<typeof cached, User | undefined>>();

  queryClient.setQueryData(options.queryKey, (old) => {
    check<Equal<typeof old, User | undefined>>();

    return old && { ...old, name: "b" };
  });

  // @ts-expect-error the data of the key is a user
  queryClient.setQueryData(options.queryKey, { id: "1" });

  const infinite = q.get("/users").infiniteOptions({
    input: (page: number) => ({ query: { page } }),
    initialPageParam: 1,
    getNextPageParam: (last) => last.next,
  });

  await queryClient.prefetchInfiniteQuery(infinite);

  const all = await queryClient.infiniteQuery(infinite);

  check<Equal<typeof all, InfiniteData<Page, number>>>();

  check<
    Equal<
      ReturnType<
        typeof queryClient.getQueryData<never, typeof infinite.queryKey>
      >,
      InfiniteData<Page, number> | undefined
    >
  >();

  q.get("/users").key({ query: { page: 1 } });
  q.get("/users/:id").key({ params: {} });

  // @ts-expect-error not a part of the route's call
  q.get("/users").key({ body: {} });

  // @ts-expect-error a page is a number
  q.get("/users").key({ query: { page: "1" } });

  const removed = q.delete("/users/:id").queryOptions({ params: { id: 1 } });

  check<Equal<Awaited<ReturnType<typeof removed.queryFn>>, null>>();
}

export function Paths() {
  // @ts-expect-error no GET route at the path
  q.get("/sessions/refresh");

  // @ts-expect-error the params are required
  q.get("/users/:id").queryOptions();

  // @ts-expect-error the header is required
  q.get("/me").queryOptions();

  const authed = queryUtils(createClient<Api, { headers: "authorization" }>());

  authed.get("/me").queryOptions();

  const typed: QueryUtils<Api, { headers: "authorization" }> = authed;

  return typed;
}

export function Untyped() {
  const loose = queryUtils(createClient());
  const any = useQuery(
    loose.get("/anything").queryOptions({ query: { a: 1 } }),
  );

  check<Equal<typeof any.data, unknown>>();
}

const Id = mockSchema<{ id: number }>();
const Item = mockSchema<{ id: number; createdAt: Date }>();
const Missing = mockSchema<{ status: 404; error: "ITEM_NOT_FOUND" }>();

const app = createApp({
  routes: [
    route({
      method: "GET",
      path: "/items/:id",
      schema: { params: Id, response: { 200: Item, 404: Missing } },
      handler: () => ({ id: 1, createdAt: new Date() }),
    }),
  ],
});

export function Direct() {
  const direct = queryUtils(createClient<typeof app>());
  const item = useQuery(
    direct.get("/items/:id").queryOptions({ params: { id: 1 } }),
  );

  check<
    Equal<typeof item.data, { id: number; createdAt: string } | undefined>
  >();

  if (item.error?.status === 404) {
    const code = item.error.body.error;

    check<Equal<typeof code, "ITEM_NOT_FOUND">>();
  }
}
