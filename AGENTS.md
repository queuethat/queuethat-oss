# Rules for coding agents

Read this, then [CONTRIBUTING.md](CONTRIBUTING.md) and the
[architecture overview](docs/architecture/README.md). The overview holds the invariants (I-1 to
I-13), the interface rules and the "Never" list. Cite an invariant by number when a change touches
it. This file adds only what an agent needs on top.

## Scope of this repository

This repository is the tenant product: everything a business and its guests use. A hosted service
can run it with extra code of its own, which plugs in through extension points and is never part
of this tree. So:

- Do not add operator-console, billing, plan or shared-sender code here, or names that only make
  sense for one hosted service (domains, support addresses, price ids). Configuration supplies them.
- When hosted code needs a new place to plug in, add a generic extension point here: an empty
  registry entry in the web app, or a no-op `private.ext_*` database function with a
  `COMMENT ON FUNCTION` that states its contract. Changing the signature of an existing extension
  point is a breaking change; say so in the pull request.
- Never remove an extension point without an issue that agrees to it first.

## Branches and merging

- Branch from `development`, open the pull request against `development`.
- `main` moves only by a release pull request from `development`.
- Merge with a merge commit or squash, as the repository settings allow. Do not rewrite history on a
  shared branch.

## Before you hand off a pull request

1. `pnpm ci:local` passes on the branch merged with the latest `development`. Paste its last line
   (`ci:local PASSED at <sha>`) into the pull request. Run it to the end; it can take over 30
   minutes. Install WebKit first: `pnpm exec playwright install webkit && pnpm exec playwright install-deps webkit`.
2. Every behaviour the pull request claims has a test (pgTAP, Vitest or Playwright) or evidence in
   the description, and anything touching tenant data has a cross-tenant test.
3. No test was skipped, narrowed or deleted to get green.
4. The description answers the three questions in CONTRIBUTING.md (new entry point, pass-through
   layer, duplicated rule) and says `Closes #n` when there is an issue.

## Database

- One migration per pull request. Right before merging, merge the latest `development` and name the
  migration with the current UTC time to the second: `$(date -u +%Y%m%d%H%M%S)_<name>.sql`.
  `scripts/check-migrations.mjs` fails a migration that does not sort after the base's newest.
- Merged migrations are never edited. Fix forward.
- A migration that redefines a function copies the body from the latest migration defining it and
  says so: `-- redefines <schema.function> from <file>`. `scripts/check-redefinitions.mjs` checks it.
- Generated files are regenerated, never hand-merged: see the table in CONTRIBUTING.md.

## Commits and pull requests

- Commit messages and pull request descriptions describe the change. Do not add tool attribution
  trailers or footers (`Co-Authored-By` for a tool, session links, "generated with" lines).
- Keep pull requests under about 400 changed lines excluding generated files.
