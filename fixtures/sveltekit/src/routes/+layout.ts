import { QueryClient } from "@tanstack/svelte-query";
import { retry } from "#lib/api.ts";
import { browser } from "$app/env";
import type { LayoutLoad } from "./$types";

export const load: LayoutLoad = () => ({
  queryClient: new QueryClient({
    defaultOptions: { queries: { enabled: browser, staleTime: 60_000, retry } },
  }),
});
