<!-- Title: type(area): summary [FEATURE-IDS], e.g. feat(web): join page [J-1]. CI checks it. -->

Closes #

**Feature IDs:**

## What changed

## Acceptance criteria

| #   | Criterion | Evidence (test name or screenshot) |
| --- | --------- | ---------------------------------- |
| 1   |           |                                    |

## Screenshots

<!-- UI changes: phone and tablet widths. Delete if none. -->

## Migration

- [ ] No migration
- [ ] Adds one migration (sorts last, types regenerated with `pnpm db:types`, `schema-change` label)

## Design review (technical-design.md 3.5)

Reviewer, answer each:

- [ ] Does this add a **shallow entry point** (a new RPC, hook or component that an existing deep one could absorb by extending)?
- [ ] Does this add a **pass-through layer** (a wrapper, Edge Function or hook that only forwards a call)?
- [ ] Does this **duplicate knowledge** owned by another module (a state-machine, ETA or permission rule re-derived in TS)?
- [ ] If the interface changed, does the PR say which two alternatives were considered?

## Definition of done

- [ ] `pnpm ci:local` passes (paste the `ci:local PASSED at <sha>` line); PR size ≤ 400 lines is a guideline, not a gate
- [ ] Every acceptance criterion maps to a named test or a screenshot above
- [ ] New tables have RLS and `supabase/tests/rls/matrix.yaml` entries; new RPCs have a cross-tenant denial test
- [ ] User-facing strings via `t()`, only `packages/ui` components, no new axe serious/critical violations
- [ ] No `.skip`, `.only` or `.fixme` without an issue link
