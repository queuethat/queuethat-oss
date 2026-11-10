# Contributing to QueueThat

Thanks for looking. This page gets you from a clone to a pull request that can be merged. The
design rules a change must keep are in the [architecture overview](docs/architecture/README.md);
read that before changing the database or a public interface.

By contributing you agree that your contribution is licensed under [AGPL-3.0-only](LICENSE), the
licence of the project.

## Before you start

- **Bugs and small fixes**: open a pull request directly.
- **Features, schema changes, new public functions**: open an issue first and describe the
  problem. The database interface is deliberately small, and a change that adds an entry point
  needs agreement before code.
- **Security problems**: do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Set up

You need Node 24 (see `.nvmrc`), pnpm 10 (`corepack enable` picks the pinned version) and Docker.

```sh
pnpm i                 # also installs the pre-commit hook that formats staged files
pnpm db:start          # local Supabase in Docker; the first run pulls images
pnpm db:reset          # applies every migration and the demo seed
cp apps/web/.env.example apps/web/.env.local
pnpm exec supabase status -o env | sed -n 's/^ANON_KEY="\(.*\)"/VITE_SUPABASE_ANON_KEY=\1/p' >> apps/web/.env.local
pnpm dev               # http://localhost:5173
```

The fourth line copies the local stack's public (anon) key into `.env.local`; without it the app
loads but every request is refused. Only public values belong in that file, never the service-role
key. The other settings in `apps/web/.env.example` are optional.

Local Supabase listens on 55321 (API), 55322 (Postgres) and 55324 (Mailpit, where local email
lands) rather than the CLI defaults, so it runs beside other Supabase projects.

Demo logins after `pnpm db:reset`, password `password123`: `owner@demo.test`, `staff@demo.test`,
and `owner@other.test` (a second organisation, for cross-tenant checks). The guest join page is
`/q/demo-barber`. Fixture ids are in `tests/fixtures/demo.ts`.

## Commands

| Task                                         | Command                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| Web app                                      | `pnpm dev`                                                                              |
| Unit tests, lint, types, build               | `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`                                |
| Database tests (pgTAP)                       | `pnpm test:db`                                                                          |
| Browser tests                                | `pnpm test:e2e` (see [tests/e2e/README.md](tests/e2e/README.md))                        |
| Browser tests, core journeys only            | `pnpm test:e2e:core`                                                                    |
| Screenshot baselines                         | `pnpm test:visual` (see [docs/ops/visual-regression.md](docs/ops/visual-regression.md)) |
| Self-host stack checks                       | `pnpm test:selfhost`                                                                    |
| Reset the database                           | `pnpm db:reset`                                                                         |
| After a `supabase/config.toml` change        | `pnpm exec supabase stop && pnpm db:start` (`db:reset` does not reload auth config)     |
| Regenerate database types                    | `pnpm db:types`                                                                         |
| Recompile the RLS matrix and allowlist tests | `pnpm db:compile-tests`                                                                 |
| **Everything CI runs**                       | **`pnpm ci:local`**                                                                     |

`pnpm ci:local` runs the same scripts as GitHub Actions: static checks, database tests, the
whole Playwright suite on desktop Chrome and iPhone (WebKit), and the screenshot baselines. It
needs Docker and takes a while. The iPhone project needs WebKit once:

```sh
pnpm exec playwright install webkit && pnpm exec playwright install-deps webkit
```

On a pull request GitHub runs less than that, to answer quickly: the static and database checks
as before, but of the browser tests only the core journeys on desktop Chrome
(`pnpm test:e2e:core`, a few minutes), and none for a change that only touches documentation.
The whole browser suite runs on `main` after the merge and every night. So a green pull request
does not prove that nothing outside the core journeys broke: that shows up as a red run on
`main`. `pnpm ci:local` is how you find out before merging.

## Generated files

These are checked in on purpose. Regenerate them with the command shown and commit the result;
never edit or hand-merge them. CI fails when one is stale.

| File                                                                           | Regenerate with                                          |
| ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `pnpm-lock.yaml`                                                               | `pnpm i`                                                 |
| `packages/db-types/src/database.types.ts`                                      | `pnpm db:reset && pnpm db:types`                         |
| `apps/web/src/routeTree.gen.ts`                                                | `pnpm dev` or `pnpm build` (the router plugin writes it) |
| `supabase/tests/rls/matrix.test.sql`, `supabase/tests/helpers/_generated.psql` | `pnpm db:compile-tests`                                  |
| `packages/domain/src/generated/`                                               | `pnpm db:reset && pnpm gen:consent`                      |
| `docs/api/openapi-v1.json`                                                     | `pnpm openapi:v1`                                        |

## Making a change

1. Branch from `main`. Write the test first where you can.
2. Keep it small: one concern per pull request, under about 400 changed lines excluding generated
   files. CI warns above that.
3. Title the pull request `type(area): summary`, for example `fix(web): keep the join button
above the keyboard`. Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `ci`, `build`,
   `perf`. CI checks the title.
4. Run `pnpm ci:local` and paste its last line (`ci:local PASSED at <sha>`) into the pull request.

### Database changes

Read [supabase/README.md](supabase/README.md). In short:

- One migration per pull request, named with the current UTC time so it sorts last
  (`$(date -u +%Y%m%d%H%M%S)_<name>.sql`). Merged migrations are never edited.
- A new tenant table needs `org_id`, RLS, a policy per command and an entry in
  `supabase/tests/rls/matrix.yaml`. A new function needs a cross-tenant denial test.
- A function that guests can call without a session must be added to
  `supabase/security-definer-allowlist.txt` with the `anon` mark, and the pull request must say
  why. Expect a security review.

### Web changes

Read [apps/web/README.md](apps/web/README.md). Components come from `packages/ui`, every string
goes through `t()`, and buttons and wait times are rendered from what the database returns
(`allowed_actions`, `eta_state`), never re-derived in TypeScript.

## What a mergeable pull request looks like

1. Every behaviour it claims has a test (pgTAP, Vitest or Playwright) or evidence in the
   description.
2. Anything that touches tenant data tests the cross-tenant case.
3. `pnpm ci:local` passes.
4. No test was skipped, narrowed or deleted to get there.
5. The description answers three questions: does this add an entry point an existing one could
   have absorbed, does it add a layer that only forwards calls, and does it copy a rule another
   module owns?

## Conduct

Be kind and specific. The [Code of Conduct](CODE_OF_CONDUCT.md) applies to issues, pull requests
and discussions.
