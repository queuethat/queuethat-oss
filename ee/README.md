# ee/: QueueThat Enterprise Edition

Code in this folder is source-available, not AGPL. It is licensed under the
[QueueThat Commercial License](LICENSE): free to read, run and change for development and testing,
and needing a paid agreement to run in production. QueueThat Cloud plans that include a feature are
that agreement for the hosted service.

Everything outside `ee/` is [AGPL-3.0-only](../LICENSE). [LICENSING.md](../LICENSING.md) explains
the split.

## Rules for this folder

- Every code file starts with `SPDX-License-Identifier: LicenseRef-QueueThat-EE`.
- Core code never imports from `ee/`. `ee/` plugs in through the extension points in
  `apps/web/src/extensions` and the database hooks, and a build opts in with
  `QT_WEB_EXTENSIONS=ee/web/extensions.ts`. A build without it contains no `ee/` code.
- `scripts/check-ee-boundary.mjs` (part of `pnpm ci:local`) fails a pull request that breaks either rule.
- Outside contributors cannot send changes to `ee/` without a separate agreement (see
  [CONTRIBUTING.md](../CONTRIBUTING.md)).

## Web code: `ee/web`

`ee/web` is the workspace package `@qm/ee-web`. One folder per feature under `ee/web/src/<feature>/`
exports its admin pages, redirects, slots and strings; `ee/web/extensions.ts` spreads them into the
`WebExtensions` the app installs. Code here reaches the app's modules as `@app/<path under
apps/web/src>`. A feature's strings are a namespace file in `ee/web/src/locales/en/`, returned from
`localeOverrides` and typed by a `ExtensionLocaleResources` declaration. Browser specs live in
`ee/tests/e2e` and run with `pnpm test:e2e:ee` (a build with `QT_WEB_EXTENSIONS` set).
