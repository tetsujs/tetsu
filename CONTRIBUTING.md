# Contributing

Thanks for looking. This file is how the repository works and what a change
is expected to come with.

For anything larger than a fix, open an issue first and describe the
design: most decisions here were made by comparing options before writing
code, and a pull request is easier to agree on when the shape is agreed.

## Setup

```bash
bun install
bun run ci
```

Nothing has to be built to work here: `paths` in `tsconfig.json` point
every package at its sources, for `tsc` and for Bun alike.

## Checks

```bash
bun run ci                          # tsc --noEmit, biome, bun test
bun run check:strictest             # sources and type tests under @tsconfig/strictest
bun run --cwd bench types --check   # the compiler's work for 200 routes, against a budget
bun run verify:packages             # pack every package; publint, attw, and a fresh consumer
```

All four run in CI. `bun run check` is not a formality: the `.test-d.ts`
files are the contract tests for type inference and for the compile errors
the framework promises, and `tsc` is the only thing that runs them.

`verify:packages` installs the packed tarballs into a project outside the
repository, imports every entry point, serves a request and type-checks it
with `skipLibCheck` off. `--typescript 5.7` runs that last step with an
older compiler; CI does it for every TypeScript version it supports.

## Layout

| Path | What is there |
| --- | --- |
| `packages/core` | the framework: routes, hooks, validation, WebSockets, and `testing` |
| `packages/*` | one package each, built on the core |
| `examples/` | a runnable file per feature, tested by `examples/recipes.test.ts`, and `examples/app` |
| `bench/` | HTTP, per-request, validation and type-cost benchmarks, and their numbers |
| `scripts/` | the build, the package check, and the core's README |

`README.md` is the documentation. The core's README is generated from it —
after editing the root one, run `bun run readme`; a test fails when they
differ.

## Building

Packages are published as `dist`: `tsc -b tsconfig.build.json` writes the
declarations, then `scripts/build.ts` bundles each package's JavaScript
into one file per entry point. `bun run build` does both, and packing a
package runs it first.

| File | What it is for |
| --- | --- |
| `tsconfig.json` | development: `tsc --noEmit`, the editor, `paths` to the sources |
| `tsconfig.lib.json` | shared build settings: declarations only, no `paths` |
| `tsconfig.build.json` | the packages `tsc -b` builds, in dependency order |
| `tsconfig.strictest.json` | the sources and type tests under a strict user's flags |
| `packages/*/tsconfig.build.json` | where one package builds to, and what it depends on |

## Conventions

- **English only**, in code, comments and documentation.
- **No ordinary comments.** Exported symbols carry TSDoc saying what the
  thing does, what it costs and what was rejected to get there. That is the
  only place reasoning is written down, so read it before changing
  something.
- **Flat code.** Early returns, blank lines between logical blocks, no
  clever brevity. Explicit beats DRY when the repetition is what makes a
  piece readable on its own.
- **A fix starts with a failing test.** Write the regression test, see it
  fail, then fix — and afterwards undo the fix for a moment to confirm the
  test catches it.
- **Integration tests go through a live server**, `serve()` from
  `@tetsujs/core/testing`: Bun's router is only reachable over a socket.
- **A type rule gets several negative cases**, not one `@ts-expect-error`:
  one example proves only that one example fails.
- **Measure before claiming performance.** Compare against a baseline in
  the same run, alternating rounds — see `bench/README.md`. A change to
  `stack.ts`, `route.ts`, `path.ts` or `context.ts` runs the type-cost
  benchmark.
- **The framework reads no environment variables.** Behaviour is set by
  options only, and a test enforces it.

## Commits

One change per commit. The subject is one line in the imperative, saying
what changed:

```
describe every package for npm
```

Add a body only when the reason is not obvious from the diff — a bug with
a subtle cause, a choice that looks wrong without context — and keep it to
a few sentences:

```
check a path's rules at startup in the compiler's order

The compiler and the runtime checked the rules in different orders, so a
path breaking two of them got a different error from each.
```

Pull requests are squash-merged, so a pull request is one change and
lands on `main` as one commit. Its title becomes that commit's subject and
follows the rules above; the description is the body, and is kept to what
a body would say. Commits inside the branch are for review and do not
reach `main`.

A change users will notice adds a line under `## Unreleased` in
`CHANGELOG.md`, in the same pull request, in one of its sections:
`### Breaking changes` first, then `### Added`, `### Changed`, `### Fixed`.
A breaking change also says, under `### Moving from <previous version>`,
what to write instead.

## Releasing

All packages share one version and are released together.

1. `bun run release <version>` on a branch sets every package's version,
   turns `## Unreleased` into the version and today's date, and updates
   `bun.lock`. It goes in as a pull request titled `release <version>`.
2. Once that is merged, tag the merge commit `v<version>` and push the
   tag.
3. The tag starts `.github/workflows/release.yml`. It waits for approval
   in the `npm` environment, then checks, packs and publishes the packages
   in dependency order through npm's trusted publishing, with provenance.
   After that it creates the GitHub release from the version's changelog
   section.

A publish that fails half-way is finished by re-running the workflow:
packages already in the registry at that version are skipped.
`bun run scripts/publish.ts <version> --dry-run` shows what would be
published without uploading anything.

## Security

Please do not open a public issue for a vulnerability. Report it privately
through GitHub's **Report a vulnerability** button on the repository's
Security tab.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
