---
title: Stability and versioning
description: How Tetsu is versioned, what may change before 1.0, what will not change after it, and which Bun and TypeScript versions are supported.
---

All `@tetsujs/*` packages share one version number and are released
together: `@tetsujs/core@0.6.0` and `@tetsujs/cors@0.6.0` were built and
tested as one. This page says what a version number promises.

## Before 1.0

- A **minor** version (`0.6.0` → `0.7.0`) may break something.
- A **patch** (`0.6.0` → `0.6.1`) never does: it is a fix, or an addition
  that changes nothing already there.

So a project on `^0.6.0` gets every patch automatically and a new minor
version only when you choose it. A release that breaks something has a
**Moving from** section in its
[release notes](https://github.com/tetsujs/tetsu/releases): what changed,
why, and how to update an application — usually a few lines the compiler
points at.

## What is settled

These parts of the design are expected to reach `1.0` as they are, and
after `1.0` change only in a major version:

- the hook slots and their order — `beforeParse`, `parse`,
  `beforeValidation`, `validate`, `beforeHandle`, the handler,
  `beforeResponse`, `afterResponse`, and `onError`;
- `hooks` as an object keyed by slot, the same on a route, a group and the
  application;
- `controller(name, build)`, with the name as the source of `operationId`s;
- `Requires<{ … }>` for what a hook needs;
- the error body `{ status, message, error }`, `onError` as the place to
  change it, and `reportError` for errors that cannot become a response;
- `createApp` returning data and `Bun.serve({ ...app })` serving it;
- `route()` and its fields.

Still moving: the exact shape of the generated OpenAPI document, and the
packages outside the core.

## After 1.0

Strict semantic versioning. A breaking change comes only in a major
version, and only after a minor version has shipped the replacement and
marked the old way as deprecated: in the types, where the editor shows it,
and in the release notes.

## Supported platforms

| | Supported |
| --- | --- |
| Bun | 1.4 and later — tested on the pinned version and on the latest |
| TypeScript | 5.7 and later, TypeScript 7 included — tested on 5.7, the newest 5.x and 7 |

Raising the minimum Bun or TypeScript version counts as a breaking change:
a minor version before `1.0`, a major one after it.

## Security fixes

Security fixes go into the latest release only. Report a vulnerability
privately through GitHub's
[Report a vulnerability](https://github.com/tetsujs/tetsu/security/advisories/new)
form, not in a public issue. The full policy is in
[`SECURITY.md`](https://github.com/tetsujs/tetsu/blob/main/SECURITY.md).
