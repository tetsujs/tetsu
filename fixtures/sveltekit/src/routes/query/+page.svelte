<script lang="ts">
import {
  createInfiniteQuery,
  createMutation,
  createQuery,
  useQueryClient,
} from "@tanstack/svelte-query";
import { queries } from "#lib/query.ts";

let { data } = $props();

const q = queries();
const queryClient = useQueryClient();

const user = createQuery(() =>
  q.get("/users/:id").queryOptions({ params: { id: data.id } }),
);

const create = createMutation(() => ({
  ...q.post("/users").mutationOptions(),
  onSuccess: (created) => {
    queryClient.setQueryData(
      q.get("/users/:id").queryOptions({ params: { id: created.id } }).queryKey,
      created,
    );

    queryClient.setQueryData(
      q.get("/users/:id").queryOptions({ params: { id: created.id } }).queryKey,
      // @ts-expect-error the key holds a user
      { id: "1" },
    );

    // @ts-expect-error the route has no body
    q.get("/users").key({ body: {} });

    return queryClient.invalidateQueries({ queryKey: q.get("/users").key() });
  },
}));

const pages = createInfiniteQuery(() =>
  q.get("/users").infiniteOptions({
    input: (page) => ({ query: { page } }),
    initialPageParam: 1,
    getNextPageParam: (last, all) =>
      last.length === 0 ? undefined : all.length + 1,
  }),
);

const missing: "USER_NOT_FOUND" | undefined = $derived(
  user.error?.status === 404 ? user.error.body.error : undefined,
);
const conflict: string | undefined = $derived(
  create.error?.status === 409 ? create.error.body.title : undefined,
);
const created: string | undefined = $derived(user.data?.createdAt);
const names: string[] = $derived(
  pages.data?.pages.flat().map((entry) => entry.name) ?? [],
);
</script>

<p>{user.data?.name} {created} {missing} {conflict}</p>
<button onclick={() => create.mutate({ body: { name: "a" } })}>new</button>
<ul>
  {#each names as name}
    <li>{name}</li>
  {/each}
</ul>
