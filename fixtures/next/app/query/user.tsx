"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { q } from "@/query";

export function User({ id }: { id: number }) {
  const queryClient = useQueryClient();
  const user = useQuery(q.get("/users/:id").queryOptions({ params: { id } }));

  const rename = useMutation({
    ...q.post("/users").mutationOptions(),
    onSuccess: (created) => {
      queryClient.setQueryData(
        q.get("/users/:id").queryOptions({ params: { id: created.id } })
          .queryKey,
        created,
      );

      queryClient.setQueryData(
        q.get("/users/:id").queryOptions({ params: { id: created.id } })
          .queryKey,
        // @ts-expect-error the key holds a user
        { id: "1" },
      );

      return queryClient.invalidateQueries({ queryKey: q.get("/users").key() });
    },
  });

  const pages = useInfiniteQuery(
    q.get("/users").infiniteOptions({
      input: (page) => ({ query: { page } }),
      initialPageParam: 1,
      getNextPageParam: (last, all) =>
        last.length === 0 ? undefined : all.length + 1,
    }),
  );

  if (user.error) {
    return (
      <p>
        {user.error.status === 404
          ? (user.error.error.error satisfies "USER_NOT_FOUND")
          : user.error.status}
      </p>
    );
  }

  if (user.data === undefined) {
    return <p>loading</p>;
  }

  // @ts-expect-error a user has no title
  user.data.title;

  const conflict =
    rename.error?.status === 409 ? rename.error.error.title : undefined;

  return (
    <div>
      <p>
        {user.data.name} {user.data.createdAt satisfies string}
      </p>
      <button
        type="button"
        onClick={() => rename.mutate({ body: { name: "a" } })}
      >
        new
      </button>
      {conflict}
      <ul>
        {pages.data?.pages.flat().map((entry) => (
          <li key={entry.id}>{entry.name}</li>
        ))}
      </ul>
    </div>
  );
}
