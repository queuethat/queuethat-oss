# Documentation

## Understand it

- [Architecture overview](architecture/README.md): the map, the modules, the invariants.
- [Technical design](architecture/technical-design.md): the original decision record.
- [ADR 0010: one list, fair order](architecture/adr/0010-unified-list-fairness.md) and
  [ADR 0011: journeys](architecture/adr/0011-journeys.md).
- [Feature spec](research/feature-spec.md): defines the feature ids (`J-1`, `S-11`, ...) cited in
  the code.
- [Security and compliance review](compliance/security-review.md) and the
  [compliance gate](compliance/phase3-gate.md) that tests it.

## Run it yourself

- [Self-hosting](selfhost/README.md) and [self-host backups](selfhost/backups.md).
- [Kiosk setup](ops/kiosk-setup.md) and [thermal ticket printing](guides/thermal-printing.md).
- [Google Business Profile join link](guides/google-business-profile.md).
- Providers: [email](ops/email-providers.md), [Telegram](ops/telegram.md),
  [SMS registration in the US (10DLC)](ops/10dlc-runbook.md), [Turnstile on joins](ops/turnstile.md),
  [Stripe test mode](ops/stripe-test-mode.md), [unsubscribe link secrets](ops/unsubscribe-secrets.md).
- People: [offboarding staff](ops/offboarding.md), [MFA lockout recovery](ops/mfa-recovery.md).

## Integrate with it

- [API v1](api/v1.md) and its [OpenAPI description](api/openapi-v1.json).
- [n8n](integrations/n8n.md), [Zapier](integrations/zapier.md), [HubSpot](integrations/hubspot.md),
  [Square](integrations/square.md).

## Work on it

- [CONTRIBUTING.md](../CONTRIBUTING.md).
- [Browser tests](../tests/e2e/README.md) and [visual regression](ops/visual-regression.md).
- [Analytics definitions](ops/analytics-definitions.md), [public-join](ops/public-join.md),
  [fonts](ops/fonts.md), [observability](ops/observability.md).
- [Realtime load test](../deploy/load/README.md) and its [results](ops/realtime-spike.md);
  [web push spike](ops/web-push-spike.md).
- Accessibility: [kiosk audit](accessibility/kiosk-audit.md) and a
  [draft statement](accessibility/statement.md). Both are drafts awaiting a hardware pass.

## Running on managed Supabase

- [Deployment checklist for Supabase Cloud](ops/pilot-deploy.md): the Auth, CAPTCHA, rate-limit and
  email settings a production project needs. Written for the first hosted pilot, so it names
  Vercel and Cloudflare; the settings apply to any managed deployment.
- [Web push device test](ops/web-push-device-test.md).
