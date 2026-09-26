/**
 * Type-level tests for the documentation controller.
 *
 * @module
 */

import type { AppRoutes } from "@tetsujs/core";
import { createApp } from "@tetsujs/core";
import { docs } from "./controller.ts";

const info = { title: "Users API", version: "1.0.0" };

const withPage = createApp({ routes: [docs({ info })] });
const withoutPage = createApp({ routes: [docs({ info, ui: false })] });
const elsewhere = createApp({
  routes: [docs({ info, path: "/spec.json", uiPath: "/reference" })],
});

export type pageCases = [
  // The page is a route of the application, where there is one…
  "GET /docs" extends keyof AppRoutes<typeof withPage> ? true : false,
  "GET /reference" extends keyof AppRoutes<typeof elsewhere> ? true : false,
  // …and the document is one whether or not there is a page.
  "GET /openapi.json" extends keyof AppRoutes<typeof withoutPage>
    ? true
    : false,
];

export const pageCasesHold: pageCases = [true, true, true];

// Without a page, the application does not claim to serve one.
export const noPage: "GET /docs" extends keyof AppRoutes<typeof withoutPage>
  ? false
  : true = true;
