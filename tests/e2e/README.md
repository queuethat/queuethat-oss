# Browser tests (Playwright)

Runs the web app against the local Supabase stack on four device projects: `desktop-chrome`,
`iphone` (WebKit), `ipad` (WebKit) and `galaxy-tab`. Pull requests run `desktop-chrome` and
`iphone`; the nightly CI run uses all four.

```sh
pnpm db:start                                   # once; needs Docker
pnpm test:e2e --project=desktop-chrome          # resets the database first
E2E_SKIP_DB_RESET=1 pnpm test:e2e smoke         # keep data between local reruns
```

`pnpm test:e2e:pilot` runs `day-in-the-shop.spec.ts` against a deployed app with no database
access. Code that spec reaches must not import the
service-role modules at load time: `supabaseEnv()` throws on `serviceRoleKey` in pilot mode.

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
