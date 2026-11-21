# Custom domains

A business can serve its join page on its own hostname (`queue.shop.com`). The database decides
whether a name is verified; the web app and the TLS layer only ask.

## Records the owner adds

On `/admin/domains` the owner claims a hostname and adds two DNS records:

| Record | Value |
| --- | --- |
| `TXT _queue-verify.<host>` | the token shown on the page (proves ownership) |
| `CNAME <host>` | `VITE_DOMAIN_CNAME` if the deployment sets it, otherwise the host of `PUBLIC_URL` |

`domain-check` re-reads the TXT record when the owner presses "Check now" and once a day. Three
failed daily checks in a row disable a verified domain.

## Who issues the certificate

- **Self-host:** Caddy's on-demand TLS asks `GET http://functions:9000/domain-check?domain=<name>`
  (on the compose network, not through Kong) at the first visit of a new name, and requests a
  certificate only when the answer is 200, which only a verified hostname of an active org gets.
  An unverified name fails the TLS handshake and Caddy contacts no certificate authority. The
  `https://` catch-all site in `deploy/selfhost/Caddyfile` then serves the static app for that
  host; staff and admin pages redirect to the main host, and the API stays on the main host.
  Ports 80 and 443 must reach Caddy for every custom name (a tunnel that ends TLS elsewhere needs
  its own certificate setup for those names). The public `/functions/v1/domain-check` Kong route
  (120 requests a minute per address) lets the SPA ask the same question.
- **A hosted deployment** may need to prepare the name first, for example add it to its hosting
  provider. It does that in its own copy of `supabase/functions/domain-check/extensions.ts`.

## Extension point: `supabase/functions/domain-check/extensions.ts`

Two no-op functions. A deployment replaces the file; never change a name or shape here without an
issue that agrees to it (AGENTS.md).

| Export | Called | Notes |
| --- | --- | --- |
| `onDomainStatusChange(change)` | once after a check really changes a domain's status | `from`, `to`, `hostname`, `domainId`, `orgId`, all read from the database. Not called for a check that leaves the status as it was. |
| `onRecheckComplete(verifiedHostnames)` | at the end of every daily re-check | The hostnames verified at that moment. Use it to heal a missed change and to remove a domain an owner deleted (a removal is an RPC, so it has no status change). |

A hook that throws is logged and ignored: it never changes the check's answer, the domain's
status or its failure count.
