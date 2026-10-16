import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";
import { cookies } from "next/headers";
import { serverQueries } from "@/query";
import { User } from "./user";

export default async function Page() {
  const queryClient = new QueryClient();
  const q = serverQueries((await cookies()).toString());

  await queryClient
    .query(q.get("/users/:id").queryOptions({ params: { id: 1 } }))
    .catch(() => undefined);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <User id={1} />
    </HydrationBoundary>
  );
}
