# Browser tests (Playwright)

Runs the web app against the local Supabase stack on four device projects: `desktop-chrome`,
`iphone` (WebKit), `ipad` (WebKit) and `galaxy-tab`.

```sh
pnpm db:start                                   # once; needs Docker
pnpm test:e2e:core                              # the core journeys on desktop Chrome
pnpm test:e2e --project=desktop-chrome          # resets the database first
E2E_SKIP_DB_RESET=1 pnpm test:e2e smoke         # keep data between local reruns
```

## What CI runs

| When                 | Tests                       | Projects                                |
| -------------------- | --------------------------- | --------------------------------------- |
| Pull request         | the core journeys (`@core`) | `desktop-chrome`, one job               |
| Push to `main`       | everything                  | `desktop-chrome` and `iphone`, 4 shards |
| Nightly              | everything                  | all four, 4 shards                      |
| `pnpm ci:local`      | everything                  | `desktop-chrome` and `iphone`           |
| `pnpm test:e2e:core` | the core journeys (`@core`) | `desktop-chrome`                        |

A pull request that only touches documentation or repository housekeeping files runs no browser
tests at all; the list is the `app` filter in `.github/workflows/ci.yml`.

The price of the fast pull request: a regression outside the core journeys is found after the
merge, as a red CI run on `main`, not before it. Whoever merged is expected to look at that run
and fix or revert. If your change is anywhere near a spec that is not in the core set, run that
spec, or `pnpm ci:local`, before you open the pull request.

The full suite on `main` and nightly gives a failed test one retry; pull requests and local runs
have none. A test that passes on its retry is reported as "flaky" and does not fail the run. Each
shard lists its flaky tests in the run summary on GitHub: read that list after a merge. A test
that shows up there more than once is a bug to fix, in the test or in the app, not noise.

## The core journeys

A test is in the core set when its title ends in `@core`. Playwright reads that as a tag, and
`pnpm test:e2e:core` runs `--grep @core`. List them with:

```sh
pnpm test:e2e:core --list
```

They cover what must never break: a guest joins and follows their place, staff sign in, call,
serve and mark a no-show, a guest leaves and comes back, the kiosk, the TV, booking, a new
owner's first line, and staff seeing only their own organization. Keep the set at a few minutes
on one runner (about 25 tests). To add a test, append ` @core` to its title; to add a journey,
prefer tagging one existing test over writing a new one. A tagged test still runs in the full
suite like any other.

## Writing tests

`pnpm test:e2e:pilot` runs `day-in-the-shop.spec.ts` against a deployed app with no database
access. Code that spec reaches must not import the
service-role modules at load time: `supabaseEnv()` throws on `serviceRoleKey` in pilot mode.

### Why the pilot runs only that journey

`playwright.pilot.config.ts` matches `day-in-the-shop.spec.ts` alone, so the other specs never run
against a deployed shop. The ones that start with
`test.skip(process.env.E2E_PILOT === '1', 'needs the service role ...')` (booking, planning,
guest forms, provider picker, console lines and the like) are a guard for someone pointing that
config at them by hand; they are not coverage the pilot is missing. Making them run there is not
sound, for three reasons:

- Their fixtures need things a deployed project gives only to the service role or to a mailbox.
  `bookableLocation()` in `support/booking.ts` confirms a new owner and a staff user through the
  Auth admin API (a deployed project has no test inbox to click a confirmation link in), then
  inserts the staff membership, availability rules, booking policy and capacity rules with the
  service role. Many specs also read Mailpit, move the clock or run SQL directly (`support/mail.ts`,
  `clock.ts`, `sms.ts`).
- They leave data behind. Each spec creates an organization of its own, and appointments and visits
  are never hard-deleted (I-1), so every run would add permanent orgs and bookings to the project
  the pilot is meant to check. The pilot journey is limited to one queue and one TV pairing that it
  archives and revokes at the end.
- Their assertions assume an empty, known shop (one seat, hourly slots 08:00 to 20:00, no other
  bookings), which is why they build their own. Pointed at the pilot's shop they would fail on its
  real services and hours or change them.

Booking and the other skipped areas are covered by the full local and `pnpm ci:local` runs on a
disposable database. If a pilot-safe booking check is wanted later, add it as a second journey
that reuses the shop's existing services and cleans up after itself, as `support/shop.ts` does,
rather than lifting these skips.

Import `test` and `expect` from `./fixtures.ts`, not from `@playwright/test`.

- `devices` gives three pages in one test, each in its own browser context: `guest` (phone,
  signed out), `staff` (tablet, signed in as `staffUser`, default `staff`) and `display`
  (1920x1080 TV). Use `test.use({ staffUser: null })` for a signed-out tablet.
- `signIn(page, 'owner' | 'staff')` signs any page in through Supabase Auth before its first
  `goto`. The demo seed creates the accounts (`owner@e2e.test`, `staff@e2e.test`); `tests/fixtures/demo.ts` owns their credentials, and global setup fails fast if they can't sign in.
- `expectNoSeriousA11yViolations(page)` fails on serious or critical axe findings.
- `eventually(() => read())` polls for cross-device changes. `waitForTimeout` is banned by lint.

`csp.spec.ts` runs against a second server, the production build behind `vite preview` on port
4173, because only that sends `public/_headers`. Use `previewUrl` there, not `baseURL`.

Traces, screenshots and videos are kept for failing tests. The smoke spec records video on
every run, and CI uploads `test-results/` and `playwright-report/` as an artifact.
