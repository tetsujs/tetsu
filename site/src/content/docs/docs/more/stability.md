---
title: Stability and versioning
description: How Tetsu is versioned, what may change before 1.0, what will not change after it, and which Bun and TypeScript versions are supported.
---

All `@tetsujs/*` packages share one version number and are released
together, so `@tetsujs/core@0.6.0` and `@tetsujs/cors@0.6.0` were built and
tested as one. This page says what a version number promises.

## Before 1.0

Until `1.0`, versions follow what `^0.x` lets a package manager install:

- a **minor** version (`0.6.0` → `0.7.0`) may break something;
- a **patch** (`0.6.0` → `0.6.1`) never does — a fix, or an addition that
  changes nothing already there.

A project on `^0.6.0` receives every patch without asking and no minor
version without choosing to. Every release that breaks something has a
**Moving from** section in its
[release notes](https://github.com/tetsujs/tetsu/releases): what changed,
why, and the edit that moves an application across — usually a few lines
the compiler points at.

There are no release candidates before `1.0`. Each release is checked
against the previous one before it is published.

## What is settled

These are the parts of the design the framework is built around. They are
expected to reach `1.0` as they are, and after `1.0` they change only in a
major version:

- the hook slots and their order — `beforeParse`, `parse`,
  `beforeValidation`, `validate`, `beforeHandle`, the handler,
  `beforeResponse`, `afterResponse`, and `onError`;
- `hooks` as an object keyed by slot, the same on a route, a group and the
  application;
- `controller(name, build)`, and the name as the contract `operationId`s
  are built from;
- `Requires<{ … }>` for what a hook needs;
- the error envelope `{ status, message, error }`, `onError` as the one
  place the format is decided, and `reportError` for what cannot be
  answered;
- `createApp` returning data and `Bun.serve({ ...app })` serving it;
- `route()` and its fields.

Still moving: the exact shape of the generated OpenAPI document, and the
packages outside the core.

## After 1.0

Semantic versioning, strictly. A breaking change comes only in a major
version, and only after a minor version has shipped the replacement and
marked the old way as deprecated — in its types, so the editor shows it,
and in the release notes.

## Supported platforms

| | Supported |
| --- | --- |
| Bun | 1.4 and later — tested on the pinned version and on the latest |
| TypeScript | 5.7 and later, TypeScript 7 included — tested on 5.7, the newest 5.x and 7 |

Raising the minimum Bun or TypeScript version is a breaking change and
comes in a minor version before `1.0`, a major one after it.

## Security fixes

Security fixes go into the latest release only. To report a vulnerability,
use GitHub's private
[Report a vulnerability](https://github.com/tetsujs/tetsu/security/advisories/new)
form rather than a public issue; the full policy is
[`SECURITY.md`](https://github.com/tetsujs/tetsu/blob/main/SECURITY.md).
