# Visual regression (DS-5)

`pnpm test:visual` compares screenshots of 15 screens with committed baselines and fails on any
visible change. `pnpm ci:local` runs it right after the e2e suite.

| Screens | Variants |
| ------- | -------- |
| Component catalogue (`/dev/ui`) | light, dark, high-contrast at 390, 820 and 1440 px wide (9 shots) |
| Join page `/q/demo-barber` | light and dark, phone |
| Guest status page | called and waiting, phone |
| Staff console | light, tablet |
| Waiting-room display | light, 1920 by 1080 |

The shots use the demo seed. The visual run has its own Playwright config
(`playwright.visual.config.ts`) so nothing else touches the data while it runs, resets the database
first, and relies on the global setup pinning every location's clock to noon. Three guests join the
Kids queue and one is called, so ticket numbers are the same every run. Text that follows the
wall clock ("Please arrive by", "Updated") is masked.

## Reading a failure

The report is in `playwright-report-visual/` (`pnpm exec playwright show-report playwright-report-visual`).
Each failure has the baseline, the new image and a diff. A token change in `theme.css` is expected
to fail many shots; a change you did not expect to touch a screen is the bug this test exists for.

## Updating baselines

Only after you have looked at every diff and agree with it:

```sh
pnpm test:visual:update
git add tests/e2e/visual/__screenshots__
```

Put the new images in the same PR as the change that caused them, and say which screens changed.

## Platform

Baselines live in `__screenshots__/linux/` and are rendered by Playwright's Chromium on Linux (the
cloud containers and CI). Text antialiasing differs on macOS and Windows, so a run there fails
every shot. Update baselines in a Linux container, not on a Mac.

## Parallel PRs

PNG baselines cannot be merged by git. When two PRs both update the same baseline, rebase the
second one, run `pnpm test:visual:update` again and commit the regenerated files.
