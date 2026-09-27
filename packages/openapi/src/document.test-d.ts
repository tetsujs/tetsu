/**
 * Type-level tests for the document's shape.
 *
 * @module
 */

import type { OpenApiDocument } from "./document.ts";

// A document built or extended by hand keeps the specification's other
// fields: `tags` became a typed field, and a tag's `externalDocs` must not
// stop compiling because of it.
export const extended: OpenApiDocument = {
  openapi: "3.1.0",
  info: { title: "Hand-made", version: "1" },
  paths: {},
  tags: [
    {
      name: "me",
      description: "The signed-in user",
      externalDocs: { url: "https://example.com/me" },
    },
  ],
};
