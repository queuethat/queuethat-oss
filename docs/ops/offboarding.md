# Offboarding staff

Remove a person with `api.remove_member` (Team page, or an owner or admin calling the RPC). Owners
can remove anyone; admins can remove managers and staff. Nobody can remove themselves, and the last
owner cannot be removed (`last_owner`).

## What happens at once

- The membership row is deleted. Every RPC and RLS policy decides access with `private.has_role`,
  which reads `app.memberships` on every call, so the next request from that person fails: reads
  return zero rows and RPCs answer `not_found` or `permission_denied`.
- All of their Auth sessions and refresh tokens are deleted (`private.revoke_member_sessions`, a
  trigger on `app.memberships`), on every device and for their other organizations too. They cannot
  mint a new access token; to work elsewhere they sign in again.
- Their waiting visits are unassigned, each with an `unassigned` event naming who removed them.
- The audit log keeps the deleted row, the reason and the actor.
- Their operator PIN lives on the membership and goes with it; their operator sessions end
  (2A-TM4).

## What does not happen at once

An access token already issued stays valid until it expires (`jwt_expiry` in `supabase/config.toml`,
300 s here). It buys nothing: every data check fails immediately. It does let a stale
console tab keep a Realtime socket until the next refresh fails. For a stricter bound set the JWT
expiry lower in the project's Auth settings; the web app refreshes
tokens itself, so shorter lifetimes are invisible to staff.

## Checking it worked

`tests/concurrency/offboarding.test.ts` runs the whole path against the local stack: remove a
signed-in member, then show that their refresh token fails and that their old access token reads no
rows and cannot call `api.call_next`.
