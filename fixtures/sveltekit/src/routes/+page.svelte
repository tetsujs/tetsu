<script lang="ts">
import { api } from "#lib/api.ts";

let { data } = $props();
let name = $state("");
let error = $state<string>();

async function create() {
  const res = await api().post("/users", { body: { name } });

  error = res.status === 409 ? res.error.title : undefined;
}

const created: string | undefined = $derived(
  "createdAt" in data ? data.createdAt : undefined,
);
const user: string | undefined = $derived(
  "name" in data ? data.name : undefined,
);
</script>

<p>{user} {created} {error}</p>
<input bind:value={name} />
<button onclick={create}>new</button>
