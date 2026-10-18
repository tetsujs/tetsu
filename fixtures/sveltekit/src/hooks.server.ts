import type { Handle } from "@sveltejs/kit/hooks";

export const handle: Handle = ({ event, resolve }) =>
  resolve(event, {
    filterSerializedResponseHeaders: (name) => name === "content-type",
  });
