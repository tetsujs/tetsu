import { queries } from "#lib/query.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch, parent }) => {
  const { queryClient } = await parent();

  await queryClient
    .query(
      queries(fetch)
        .get("/users/:id")
        .queryOptions({ params: { id: 1 } }),
    )
    .catch(() => undefined);

  return { id: 1 };
};
