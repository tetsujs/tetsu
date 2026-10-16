import { createClient, unwrap } from "@tetsujs/client";
import type { Api } from "./api.contract";

export function api(cookie?: string) {
  return createClient<Api, { headers: "authorization" }>({
    baseUrl: process.env.NEXT_PUBLIC_API ?? "http://localhost:3000",
    headers: () => ({
      authorization: "Bearer token",
      ...(cookie === undefined ? {} : { cookie }),
    }),
  });
}

export async function user(id: number) {
  const res = await api().get("/users/:id", { params: { id } });

  if (res.ok) {
    return res.data.createdAt satisfies string;
  }

  if (res.status === 404) {
    return res.error.error satisfies "USER_NOT_FOUND";
  }

  return res.error?.message;
}

export async function users() {
  const list = unwrap(
    await api().get("/users", { query: { page: 2, since: new Date() } }),
  );

  // @ts-expect-error the role is one of two
  list[0]?.role satisfies "guest";

  return list.map((entry) => entry.name);
}

export async function create(name: string) {
  const res = await api().post("/users", { body: { name } });

  if (res.status === 409) {
    return res.error.title;
  }

  // @ts-expect-error a body without a name
  await api().post("/users", { body: {} });

  return res.ok ? res.data.id : undefined;
}

export async function tree() {
  const root = unwrap(await api().get("/categories"));

  return root.children.flatMap((child) =>
    child.children.map((leaf) => leaf.name),
  );
}

export async function upload(file: File) {
  await api().post("/uploads", { form: { title: "a", size: file.size, file } });
  await api().put("/blobs/:id", { params: { id: 1 }, body: file.stream() });

  const csv = await api().get("/export");

  return csv.ok ? csv.response.text() : undefined;
}
