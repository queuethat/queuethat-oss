# Phase 3 compliance gate

Passing this suite on the branch you deploy is the precondition for setting
`app.platform_flags.compliance_gate_passed_at` (the step in the
[self-host guide](../selfhost/README.md#turning-on-sms-whatsapp-or-payments)). Until that column is set the database refuses to
switch any paid channel on (`channel_prerequisite_missing`).

The suite encodes every bullet of `docs/compliance/security-review.md` section 9 "Phase 3". It
runs against fake providers and recorded fixtures only; no live account is needed.

| Run it | What it covers |
| --- | --- |
| `pnpm exec supabase test db supabase/tests/compliance` (the `compliance` CI job; also part of `pnpm test:db`) | database behaviour, `supabase/tests/compliance/phase3.test.sql` |
| `pnpm exec vitest run tests/compliance` (also part of `pnpm test`) | webhook signatures and replay on the `provider-webhook` handler against recorded fixtures, and this table, `tests/compliance/phase3.test.ts` |

Each check is named `CG14-nn` in its description. `phase3.test.ts` fails if a row below names a
check that does not exist, if a check exists that no row lists, or if a bullet is added to section 9
without a row.

| # | Criterion (compliance.md section 9, Phase 3) | Checks | Behaviour owned by |
| --- | --- | --- | --- |
| G1 | Webhooks reject invalid Twilio/Stripe/Meta signatures before any write; replayed event ids are no-ops | CG14-01 | 3-CG2 (#327) |
| G2 | STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT suppress within one call; START/UNSTOP lift it; HELP names the business and contact; staff cannot send to a suppressed number | CG14-02, CG14-03, CG14-04, CG14-05 | 3-CG8 (#333) |
| G3 | Non-urgent messages wait for 08:00-20:00 location time, "called" is exempt, across DST | CG14-06 | 3-CG9 (#334) |
| G4 | Marketing templates need a `marketing` consent; transactional consent alone blocks them | CG14-07 | 3-CG7 (#332) |
| G5 | Staff-added contacts need an attestation recorded on the consent row | CG14-08 | 3-CG3 (#328) |
| G6 | Per-org daily cap and country allowlist are enforced before the provider call; alert at 80% | CG14-09 | 3-PV6 (#345), 3-PV7 (#346) |
| G7 | Consent copy is versioned; the consent row stores version and hash | CG14-10 | 3-CG5 (#330) |
| G8 | WhatsApp outside 24 h only via approved templates; opt-in recorded with channel `whatsapp` | CG14-11 | 3-WA2 (#359) |
| G9 | Promotional email carries an unsubscribe link and the postal address; unsubscribe is honoured immediately | CG14-12 | 3-EM3 (#349) |
| G10 | Hosted only: DPA, subprocessor list, privacy policy reviewed by a lawyer; ToS forbids PHI | none: a legal task, tracked as 3-CG12 (#337). `hosted_legal_reviewed_at` gates the platform messaging account separately. | 3-CG12 |

## Cross-tenant

CG14-13: org B's STOP from the same number does not suppress it for org A, org B cannot read org A's
suppressions, and org B cannot attest consent on an org A visit.

## When a check fails

Fix the behaviour, never the check. A check may change only when the criterion it encodes changes in
compliance.md, in the same PR.
