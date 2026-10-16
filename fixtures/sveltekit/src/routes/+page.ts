import { api } from "#lib/api.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch, params }) => {
  const res = await api(fetch).get("/users/:id", { params: { id: 1 } });

  if (res.ok) {
    return { name: res.data.name, createdAt: res.data.createdAt, params };
  }

  if (res.status === 404) {
    return { missing: res.error.error satisfies "USER_NOT_FOUND" };
  }

  // @ts-expect-error a status the route does not declare has no USER_NOT_FOUND
  res.error?.error satisfies "USER_NOT_FOUND";

  return { failed: res.status };
};
