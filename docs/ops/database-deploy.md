# Applying migrations to production

Production is deployed by **Supabase's GitHub integration**, connected to `main`. When a release
is merged, Supabase itself applies the new migrations and deploys the Edge Functions. Nothing in
GitHub Actions does it.

The workflow **Database migrations (manual)** (`.github/workflows/deploy-database.yml`) is a
second tool, started only by hand. It shows the remote migration history and what a push would
apply, and it can apply migrations with the CLI when the integration is switched off or has
failed. It never runs on a push, so the two never act on the same merge.

The **dev** Supabase project (`uryiqventewtwkkgfehe`) has its own copy of the integration, connected to
`development` (added 2026-11-12). A merge to `development` applies migrations and deploys the Edge Functions
to dev, so dev no longer falls behind. Before that it was deployed by hand and had drifted 45 migrations.
Production stays on `main` only.

What the integration does is taken from Supabase's page
[GitHub integration](https://supabase.com/docs/guides/deployment/branching/github-integration),
read on 2026-11-10. Reread it before relying on a detail: the integration is Supabase's and can
change without a change here.

## What the integration does on a merge to `main`

With **Deploy to production** on, every push to `main`:

- **Applies every file in `supabase/migrations` that has no entry in the remote migration
  history.** "Each later commit runs only the migrations that haven't been applied yet." Each
  file runs inside one transaction.
- **Deploys the Edge Functions declared in `supabase/config.toml`** under `[functions.<slug>]`. A
  function is redeployed only when its code or its `verify_jwt` setting changed.
- **Deploys storage buckets declared in `config.toml`.** There are none: the
  `[storage.buckets.*]` example is commented out. Keep it that way unless a bucket is meant for
  production.
- **Saves Vault secrets declared under `[db.vault]`** before the migrations. There are none (the
  section is commented out). Never add one for local use: it would be written to production.
- **Ignores everything else**: API and Auth settings, seed files. "Data changes in your seed
  files are not merged to production." Function secrets and dashboard settings are still set by
  hand ([pilot-deploy.md](pilot-deploy.md)).

### What it does not do that the CLI did

`supabase db push` refuses a migration file that is older than the newest applied one. The
integration does not: "A migration file with a timestamp older than the latest applied migration
still runs and the step finishes with a warning." So **nothing at deploy time stops a migration
from running. If the file is on `main` and not in the history, it runs.**

The only gate is before the merge: `scripts/check-migrations.mjs` and
`scripts/check-hosted-functions.mjs`, which run in `scripts/ci-static.sh` (the `static` job in
CI, and `pnpm ci:local`). The second one is what keeps the public repository's drop migration
out of the hosted database ([oss-sync.md](oss-sync.md)).

**Never merge a PR into `main` before its `static` check (and `ci-ok`) is green.** GitHub does not
enforce this on a private repository on the free plan ([git-workflow.md](git-workflow.md)), so
until that is fixed it is a rule people follow, with nothing behind it. And read the migrations
in every release: `git diff origin/main origin/development --stat -- supabase/migrations`.

### Do not add a `[remotes]` block

`supabase/config.toml` describes the **local** stack: `site_url = "http://localhost:5173"`, local
ports, local auth and rate-limit values. On production the integration ignores the `[db]`,
`[api]`, `[auth]`, `[storage]` and `[experimental]` sections unless a `[remotes]` block names the
production project. Adding one would make every merge push those local values over the production
settings in [pilot-deploy.md](pilot-deploy.md). There is no `[remotes]` block today. Adding one
is a decision for Riz, with every value in those sections reviewed for production first.

### Migrations that cannot run in a transaction

The integration "runs each migration file inside a single transaction". A migration with
`create index concurrently` (or anything else Postgres refuses inside a transaction) fails when
the integration deploys it. No migration here uses one today. If one is ever needed, do not put
it in a release as an ordinary file and hope: plan it with Riz, and apply it by hand first (the
manual workflow, below) so that the integration finds it already in the history.

### Edge Functions

Only declared functions deploy. Every folder in `supabase/functions` is declared in `config.toml` now
(`pair-device` was added on 2026-11-12; it had been deployed by hand). A new function folder needs its
`[functions.<name>]` entry in the same PR, or the integration skips it. To recheck the list:

```sh
comm -23 <(ls supabase/functions | grep -v '^_' | sort) \
         <(grep -o '^\[functions\.[^]]*' supabase/config.toml | cut -d. -f2 | sort)
```

Two declared functions exist for local testing and are deployed to production all the same:
`dev-sms-inbound` (answers 404 unless `DEV_INBOX_ENABLED=true`) and `payments` (404 unless
`PAYMENTS_DEV=true`). Never set either variable in the production project's function secrets.

`verify_jwt` in `config.toml` is now what production gets. A function with `verify_jwt = false`
is reachable by anyone on the internet, so its entry must say what the gate is instead (a
signature, a token, `DISPATCH_SECRET`). Review a change to any `verify_jwt` line as a security
change.

### Automatic branching

**Automatic branching** is a separate switch in the same settings. With it on, Supabase creates a
preview branch, with its own database, for GitHub branches (all of them, or with "Supabase
changes only", those that touch `supabase/`). This repository opens a branch for every change. Preview
branches are billed per branch under Supabase's pricing; check the current pricing page before
turning it on. **Keep it off** unless Riz decides previews are wanted. It is not needed for
deploying to production.

## Before turning "Deploy to production" on (once)

Production was migrated by hand until now. The integration decides what to run from the remote
migration history (`supabase_migrations.schema_migrations`) alone. If that table does not list a
migration whose changes are already in the database, the integration runs the file again against
a schema that already has it. Most of the 300-odd files would fail, and some would not fail and
would do damage (a `create or replace` of an old function body over a newer one).

**The remote history must list every migration in the repository except the ones that are
genuinely new.** Check it before the toggle goes on, and again if the project is ever restored
from a backup.

1. **Look.** Run **Database migrations (manual)** from the Actions tab with `dry_run` ticked
   (setup below), or from a machine:

   ```sh
   pnpm exec supabase login                            # once per machine
   pnpm exec supabase link --project-ref <ref>
   pnpm exec supabase migration list --remote          # -p <password>, or SUPABASE_DB_PASSWORD in the shell
   ```

   Every row should show the same version under Local and Remote. A version under **Local only**
   is one the integration will run on the next push to `main`.

2. **If the Local-only versions are exactly the migrations merged since production was last
   migrated**, the history is right. Turn the toggle on; they run on the next push.

3. **If older versions are Local-only** (or the Remote column is empty), the history is missing
   entries. For each such version, decide whether its changes are already in the database:
   - Open the file and look for what it creates: a table, a column, a function, a policy. In the
     dashboard's SQL editor, check that it is there, for example
     `select to_regclass('app.waiver_acceptances');`,
     `select 1 from information_schema.columns where table_schema = 'app' and table_name = 'visits' and column_name = '…';`
     or `select pg_get_functiondef('api.join_queue'::regproc);` compared with the newest
     definition in the repository.
   - For many versions at once, compare whole schemas: dump production's with
     `pnpm exec supabase db dump --remote -f prod-schema.sql`, dump a local database built from
     the same commit (`pnpm db:reset`, then `pnpm exec supabase db dump -f local-schema.sql`), and
     diff the two. No difference in tables, columns, functions and policies means every
     migration up to that commit is in production. Delete both files afterwards.

   Record as applied **only** the versions you have verified this way:

   ```sh
   pnpm exec supabase migration repair --remote --status applied <version> <version> …
   pnpm exec supabase migration list --remote          # check again
   ```

   `repair` writes rows in the history table and runs nothing. Recording a version whose changes
   are not in the database is worse than the missing row: that migration will then never run,
   and later ones build on a schema that is not there. A version you cannot verify stays
   unrecorded until you can.

4. **Check the integration's settings** in the Supabase dashboard (Project Settings →
   Integrations → GitHub):
   - the repository is this one and the production branch is `main`;
   - **Working directory** is `.` (the `supabase/` folder is at the repository root);
   - **Deploy to production** is in the state you intend. It should be off until steps 1 to 3
     are done;
   - **Automatic branching** is off.

## The routine

1. The `development` → `main` release PR is green (`static`, `ci-ok`). Read
   `git diff origin/main origin/development --stat -- supabase/migrations`: these files will run.
2. Merge it. Supabase applies the migrations and deploys changed functions. Vercel builds the
   web app from the same push; nothing ties the two together.
3. Check the result in the Supabase dashboard (the production branch's deployment log), then run
   the manual workflow as a dry run or `supabase migration list --remote`: every version is under
   both Local and Remote.

Migrations are expand/contract (I-12), so the web bundle that is already running keeps working
whichever of the two finishes first. A new bundle cannot use what a migration adds until the
migration has run, so look at the deployment log soon after merging. A contract migration (one
that drops something) belongs in the release after the one whose bundle stopped using it.

## When the integration's step fails

Read the failed step's log in the Supabase dashboard first. Each file runs in one transaction, so
the failing file leaves nothing behind; files before it in the same push stay applied. The
integration "runs again on every push to the git branch", and Supabase's page describes no retry
button, so a file that failed is tried again on the next push to `main` and blocks the files
after it until it succeeds or is in the history.

- **"A version in the branch's migration history with no matching file fails the step."**
  Production has a migration that `main` does not: someone applied one by hand, or a file was
  renamed or removed after it was applied. Do not delete the history row. Find the file and bring
  it to `main` through a PR.
- **The file cannot run in a transaction.** Apply it by hand with the manual workflow (below).
  The CLI records it, and the integration then skips it.
- **A passing fault** (a lock timeout, a connection drop). Apply by hand with the manual
  workflow, or let the next push retry it.
- **The SQL is wrong for production's data** (a constraint existing rows break, a missing
  object). Stop and decide with Riz. Either correct the data so the file can pass, or, because
  the file has never been applied to production, replace it in a hotfix PR to `main`. That is an
  exception to "a merged migration is never edited" and is Riz's call each time.
- **A function fails to deploy.** The database is unaffected. Fix the function in a PR; until
  then production runs the previous version of it.

## The manual workflow

Actions → **Database migrations (manual)** → Run workflow.

| Run                                        | What it does                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `dry_run` ticked (the default), any branch | Prints `supabase migration list` and `supabase db push --dry-run`. Writes nothing |
| `dry_run` cleared, on `main`               | The same, then `supabase db push`, then the migration list again                  |
| `dry_run` cleared, on any other branch     | Fails at the first step. Migrations apply from `main` only                        |
| Any run before the secrets exist           | Prints "not configured" and passes. Nothing is contacted                          |

Apply by hand only when the integration is off or its step has failed, and never while a push to
`main` is still being deployed. Whatever the CLI applies is recorded in the same history table,
so the integration does not run it again.

The CLI is stricter than the integration. It refuses a file older than the newest applied
migration ("Found local migration files to be inserted before the last migration on remote
database"), and the dry run fails the same way. In a dry run that is a finding, not a fault: it
names files the integration **would run** on the next push. The workflow never forces such a file
and never repairs the history. If the file is the placeholder
`20261110171733_drop_hosted_schema.sql` or another file that only runs `select 1;`, either let
the integration run it or record it with
`supabase migration repair --remote --status applied <version>`; both leave the database the
same. For a file that does something, read it for anything that assumes it ran earlier before
letting either tool apply it.

### Setup (once)

1. Settings → Environments → New environment, named exactly `production`. Optionally tick
   **Required reviewers** and add yourself, so each run waits for approval. On a private
   repository, environment secrets and required reviewers need a paid GitHub plan; without one,
   add the secrets below as repository secrets (the workflow reads either).
2. Add three secrets:

   | Secret                  | Value                                         | Where to find it                                                                                                                                                                                        |
   | ----------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `SUPABASE_PROJECT_REF`  | The production project's 20-letter id         | Supabase dashboard → the production project → Project Settings → General → Project ID. It is also the `<ref>` in `https://supabase.com/dashboard/project/<ref>`                                         |
   | `SUPABASE_DB_PASSWORD`  | The database password of that project         | It is the password inside `BACKUP_DB_URL` ([backups.md](backups.md)), so your password manager has it. The dashboard never shows it again; Database → Settings → Reset database password sets a new one |
   | `SUPABASE_ACCESS_TOKEN` | A Supabase access token for the CLI (`sbp_…`) | Supabase dashboard → your avatar → Account preferences → Access Tokens → Generate new token                                                                                                             |

   If you reset the database password, update `BACKUP_DB_URL` too, or the nightly backup fails.

## Rollback

Migrations are forward-only. There are no down migrations, and a merged migration is never edited
(I-12). To undo a change, write a new migration that reverses it and release that.

Data lost to a bad migration comes back only from a backup. The nightly backup and the weekly
restore drill (`backup.yml`, `restore-drill.yml`, [backups.md](backups.md)) exist for that. Before
a release with a risky migration, run **Backup** from the Actions tab first and wait for it to
finish. After restoring into a project, repeat the history check above before connecting the
integration to it.
