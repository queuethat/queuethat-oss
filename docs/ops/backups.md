# Backups and the restore drill

O7 (#78). The Supabase Free plan keeps no backups. Each night `backup.yml` dumps the pilot
database, encrypts it with [age](https://age-encryption.org) and uploads it to Cloudflare R2,
keeping the newest 14. Each Monday `restore-drill.yml` restores the newest backup into a throwaway
local stack and checks that it works. The 14 days are the outer bound the privacy notice
discloses (technical-design.md, Retention).

## What a backup holds

One folder per run, `db/<UTC stamp>/` (for example `db/2026-10-30T031512Z/`). Every file is
age-encrypted:

| File                 | What                                                               |
| -------------------- | ------------------------------------------------------------------ |
| `roles.sql.age`      | role settings (`supabase db dump --role-only`)                     |
| `schema.sql.age`     | our schemas: tables, functions, policies, grants                   |
| `data.sql.age`       | every row, including `auth` (accounts, password hashes) and guests |
| `migrations.sql.age` | migration history, so `supabase db push` still works after restore |
| `vault.sql.age`      | Vault secrets, decrypted (see below)                               |
| `cron.sql.age`       | pg_cron jobs                                                       |
| `counts.tsv.age`     | row count per table, which the drill compares                      |

`supabase db dump` leaves the last three out, and a restore without them would be silently
broken. Vault encrypts secrets with a key that stays with the Supabase project, so a backup can
only carry them decrypted. That is why `vault.sql` is sealed like everything else.

**Personal data.** Dumps contain guest names, phones and emails. `scripts/backup.sh` pipes each
dump straight into `age`, so plaintext never touches the runner's disk, and only `.age` files are
uploaded. The drill decrypts into a pipe to `psql`. Never decrypt a backup to a file. If you must,
do it on an encrypted disk and delete the file afterwards.

## Setup (once, by the maintainer)

1. **age key pair**, on your own machine: `age-keygen -o qm-backup.key`. The `Public key:` line is
   the recipient.
   - Keep `qm-backup.key` in your password manager.
   - Without it, no backup can ever be read. With it, anyone can read every backup.
2. **R2 bucket.** In Cloudflare, go to R2 and create the bucket `qm-backups` (no public access).
   Then create two API tokens under R2 → Manage API tokens:
   - `qm-backup-write`: Object Read & Write on that bucket only. Used by the nightly backup.
   - `qm-backup-read`: Object Read only on that bucket. Used by the drill.
   - The endpoint is `https://<account id>.r2.cloudflarestorage.com`.
3. **Healthchecks.io.** Create two checks:
   - `qm-backup`: period 1 day, grace 2 hours.
   - `qm-restore-drill`: period 7 days, grace 6 hours.

   Copy each ping URL. See [observability.md](observability.md).
4. **Database URL.** In Supabase, open Connect and copy the **session pooler** URI. It looks like
   `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`.
   Use the session pooler, not the transaction pooler: pg_dump needs session mode. Use the direct
   host only if your runner has IPv6.
5. **GitHub.** In the repo, go to Settings → Secrets and variables → Actions:

   | Kind     | Name                            | Value                                         |
   | -------- | ------------------------------- | --------------------------------------------- |
   | Secret   | `BACKUP_DB_URL`                 | session pooler URI from step 4                |
   | Secret   | `BACKUP_S3_WRITE_KEY_ID`        | `qm-backup-write` Access Key ID               |
   | Secret   | `BACKUP_S3_WRITE_SECRET`        | `qm-backup-write` Secret Access Key           |
   | Secret   | `BACKUP_S3_READ_KEY_ID`         | `qm-backup-read` Access Key ID                |
   | Secret   | `BACKUP_S3_READ_SECRET`         | `qm-backup-read` Secret Access Key            |
   | Secret   | `BACKUP_AGE_IDENTITY`           | the `AGE-SECRET-KEY-1...` line of the key file |
   | Secret   | `BACKUP_HEALTHCHECK_URL`        | `qm-backup` ping URL                          |
   | Secret   | `RESTORE_DRILL_HEALTHCHECK_URL` | `qm-restore-drill` ping URL                   |
   | Variable | `BACKUP_AGE_RECIPIENT`          | the `age1...` public key                      |
   | Variable | `BACKUP_S3_ENDPOINT`            | the R2 endpoint from step 2                   |
   | Variable | `BACKUP_S3_BUCKET`              | `qm-backups`                                  |

6. **Prove it.**
   - Run **Backup** from the Actions tab (Run workflow) and check that a folder appears in the
     bucket.
   - Then run **Restore drill** and check that it ends with `restore drill passed`.
   - Both Healthchecks turn green.

`BACKUP_AGE_IDENTITY` in GitHub means anyone who can change workflows on the default branch can
read the backups. That is acceptable while the project has one maintainer. Revisit it when that
changes, for example by moving the drill to a machine the maintainer controls.

**Without GitHub Actions** (it can't run jobs while the account is out of minutes), run the
same scripts from any machine with Docker, `age`, `psql` and the `aws` CLI, with the same names
as environment variables. Use `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and
`AWS_DEFAULT_REGION=auto` for the R2 token:

Install `age` first: `brew install age` on macOS, `apt install age` on Debian or Ubuntu. Both scripts
stop with that hint when it is missing, and they always use the repo's pinned Supabase CLI
(`pnpm exec supabase`), never a global one.

```sh
bash scripts/backup.sh                                       # one backup
BACKUP_AGE_IDENTITY_FILE=qm-backup.key bash scripts/restore-drill.sh   # wipes your local stack
```

## What the drill checks

`scripts/restore-drill.sh` empties the local database, with no migrations and no seed. It restores
roles, schema and data in one transaction, in replica mode, so triggers don't fire twice. Then it
restores the migration history, the Vault secrets and the cron jobs. It never calls production:
it deletes the `dispatcher_*` secrets and turns every cron job off. Then it checks:

1. Every table has exactly the row count recorded at backup time.
2. The migration history and `guest_token_secret` are there, and RLS is on for every `app` table.
3. A guest can open the first location's join page through the API (`get_location_public`).
4. A restored owner, with a token signed by the local stack, reads exactly their own org's
   locations.
5. On a local seeded backup only (it needs the demo accounts), the Playwright smoke spec runs
   against the restored database. Set `DRILL_E2E=1` or `0` to force it on or off.

Any failure exits non-zero, which fails the job and pings Healthchecks `/fail`.

## Restoring for real

When the pilot project is lost or corrupted, restore into a **new** Supabase project. Don't
restore into the damaged one.

1. Create the project, then copy its session pooler URI as `NEW_DB_URL`.
2. Download the newest backup folder from R2. In a shell where `qm-backup.key` is available, run:

   ```sh
   k=qm-backup.key; d=2026-10-30T031512Z   # the folder
   { age -d -i $k $d/roles.sql.age; age -d -i $k $d/schema.sql.age
     echo 'SET session_replication_role = replica;'; age -d -i $k $d/data.sql.age
   } | psql "$NEW_DB_URL" --single-transaction -v ON_ERROR_STOP=1
   { echo 'create schema if not exists supabase_migrations;'
     echo 'create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);'
     age -d -i $k $d/migrations.sql.age; age -d -i $k $d/vault.sql.age; age -d -i $k $d/cron.sql.age
   } | psql "$NEW_DB_URL" --single-transaction -v ON_ERROR_STOP=1
   ```

   The drill rehearses these exact steps locally, but they haven't been run against a hosted
   project yet. If `roles.sql` fails on a `GRANT SET ON PARAMETER` line for a Supabase-managed
   role (the drill restores as the local superuser for this reason), delete that line and rerun:
   Supabase sets those roles up itself.

3. Vault now holds the old project's secrets. Update the ones that name the old project, such as
   `dispatcher_url`, and set the new project's Edge Function secrets
   ([pilot-deploy.md](pilot-deploy.md)).
4. Point the web app's `VITE_SUPABASE_URL` and anon key at the new project and redeploy. Update
   `BACKUP_DB_URL`.
5. Guest links (`/v/<token>`) keep working: the database holds only their hashes. Staff sign in
   with their old passwords, because the password hashes are in `auth.users`.

## Vault key custody (provider credentials)

Since 3-PV1 (#340) each org's SMS, email, WhatsApp and payment credentials live in Vault
(`app.provider_settings.secret_ids` points at them). The database holds them encrypted; the key
that decrypts them is **not in the database**, so a database dump alone restores Vault rows that
nobody can read.

- **Hosted Supabase.** The key stays with the project. Our `vault.sql.age` backup carries the
  secrets decrypted (sealed by `age`), so a restore into a **new** project re-encrypts them under
  that project's own key. Nothing to keep beyond the age key above.
- **Self-host.** Vault uses the root key in the `VAULT_ENC_KEY` environment variable of the
  Supabase `vector`/`supavisor`/Postgres stack (`PGSODIUM_ROOT_KEY` on older images). Treat it like
  the age key:
  1. Generate it once (`openssl rand -hex 32`) and store it in a password manager, outside the
     server and outside the backup bucket.
  2. Back up the database as usual **and** keep that key. Raw volume or `pg_dump` copies of
     `vault.secrets` are useless without it; use the `vault.sql` export above if you want to move
     to a host with a different key.
  3. If the key is lost, the secrets cannot be recovered. Each owner re-enters their provider
     credentials on `/admin/integrations`; channels stay disabled until their next signed test
     event (set_provider_settings clears `verified_at` and the enable switch on any credential change).
- After any restore, check **Admin > Integrations**: a card showing `****1234` hints but failing
  sends means the key does not match.
- `api.get_channel_config` and `api.get_webhook_secret` are the only readers. Both are
  service-role only, and the dispatcher keeps the result in memory for one invocation.
