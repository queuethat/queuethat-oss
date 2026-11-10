# Self-host backups

The `backup` profile takes an encrypted backup every night and keeps the newest 14. Backups hold
guest names, phones and emails, so every file is encrypted with [age](https://age-encryption.org)
before it touches disk: without your private key nothing in a backup can be read. The 14 days are
the outer bound the privacy notice discloses for retention and erasure.

## Set up

1. `./setup.sh --backup-key` (or answer `y` when it asks, or add `BACKUP_AGE_RECIPIENT` yourself
   with a key from `age-keygen`). It prints the **private key once** and does not keep it. Store it
   offline, for example in a password manager. Lose it and no backup can ever be read; share it and
   everyone who has it can read every backup. Needs `age` on the machine that runs setup.
2. `docker compose --profile backup up -d`. A backup runs daily at `BACKUP_TIME` (UTC, default
   `03:00`). Run one now with `docker compose --profile backup run --rm backup now`.

Optional settings in `.env`: `BACKUP_KEEP` (default 14), `BACKUP_TIME`, `BACKUP_PATH` (host folder,
default `./backups`), `BACKUP_HEALTHCHECK_URL` (a Healthchecks.io URL, pinged on success and on
failure), `BACKUP_RCLONE_REMOTE` (for example `r2:my-bucket/qm`) with `BACKUP_RCLONE_CONFIG`, the
path of an rclone config file on the host that defines the remote (`rclone config` writes one).

**Keep the backup store write-protected.** The public key is in `.env`, so anyone who can write to
`./backups` or the remote bucket can craft a file that decrypts fine and then runs as the restore.
Give the backup job append-only access, and only restore backups you trust.

**A backup on the same disk is not a backup.** Copy `./backups` somewhere else (that is what
`BACKUP_RCLONE_REMOTE` is for), and keep the private key and a copy of `.env` away from the server.

## What a backup holds

One folder per run, `backups/<UTC stamp>/`, with only `.age` files:

| File                | What                                                                           |
| ------------------- | ------------------------------------------------------------------------------ |
| `db.dump.age`       | the whole database: every schema, accounts (`auth`), file metadata, Vault      |
| `storage.tar.age`   | uploaded files (logos)                                                         |
| `db-config.tar.age` | the pgsodium key that decrypts the Vault secrets (the guest-link secret, etc.) |

The Vault secrets are encrypted inside the dump, and their key lives in a Docker volume of its own,
so it is in the backup too. This differs from the hosted pilot's backup (`docs/ops/backups.md`),
which has to decrypt Vault because it cannot take the key. Here the backup is complete by itself.

## Restore

Onto a **fresh** stack (new machine, or after `docker compose down -v`):

```sh
cd deploy/selfhost
cp /safe/place/.env .env              # the .env of the install you are restoring
cp -r /safe/place/backups .            # or only the folder you want
./restore.sh --identity /safe/place/qm-backup.key          # newest backup; or --backup backups/<stamp>
```

Backup folders are written by the backup container as root and are readable by root only, so run
`restore.sh` as root (`sudo ./restore.sh ...`) unless you already are.

It puts the Vault key back, restores the database and the uploaded files, and starts the stack.
It refuses a database that already holds an organization unless you pass `--yes`, because the
restore replaces it. Use the old `.env`: its JWT keys must match, or signed-in sessions and paired
displays stop working. Then sign in and open a queue's join page. Guest links keep working (the
database holds only their hashes), and staff keep their passwords.

`pg_restore` prints a handful of ignored errors on a fresh stack (roles and objects that the
services create themselves). `restore.sh` reports the count; the log is `/tmp/restore-errors.log`.

## Tested by

`tests/check-backup.sh` makes a backup of a running stack, checks that only `.age` files exist and
that a wrong key opens nothing, wipes the stack, restores it and compares organization, visit,
account and file counts and the logo's bytes. The `selfhost-smoke` workflow runs it, then runs a
smoke journey on the restored stack. `tests/backup.bats` covers retention (15 backups leave 14).
Run `check-backup.sh` yourself after setting up (it **wipes** the stack it runs on, so use a test
install).
