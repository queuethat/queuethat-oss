# Web push spike (K2, #29)

> **Removed after N4 (2026-10-25).** The spike's function (`supabase/functions/push-spike/`) and its test page (`apps/web/public/push-spike/`) are gone so the outbox dispatcher stays the only sender (I-11). Its send path lives on in `supabase/functions/_shared/web-push.ts`; the rest is in git history at `9a9456f`. The device test below now runs through N4's web push channel in `dispatch-notifications`; the guest flow (N5) is in [web-push-device-test.md](web-push-device-test.md).

**Question.** Can a Supabase Edge Function (Deno) send standards web push (VAPID, RFC 8292, and aes128gcm payload encryption, RFC 8291) without a fallback dispatcher container?

**Answer: yes for the send path. Keep the Edge Function; the container fallback is not needed.** The function in `supabase/functions/push-spike/` runs in the Supabase edge runtime, signs VAPID, encrypts the payload, and Google's real push service (FCM) accepted its messages with `201 Created`. Delivery to a phone, and the iPhone behaviour behind decision D1, still need the device test below, because the cloud sandbox can't hold Chrome's push connection open.

## What was proven, and how

| Claim | Evidence | Where it ran |
|---|---|---|
| The library loads and runs in the Supabase edge runtime | `supabase functions serve push-spike` boots it and answers | Local stack, edge runtime 1.77.8 (Deno 2.1 compatible) |
| VAPID JWT is valid (ES256 signature, `aud` = push service origin, `exp` within 24 h, `sub` mailto/https) | `verify.ts` fake push service checks each claim before accepting | Edge runtime → fake push service on the host |
| The payload decrypts the way a browser decrypts it | `verify.ts` decrypts with plain WebCrypto written from RFC 8291 3.4 and RFC 8188, sharing no code with the library | Same |
| Largest payload is 3993 bytes | 3993 bytes plaintext is exactly 4096 bytes on the wire and decrypts; 3994 is refused before sending | Same |
| The verifier isn't vacuous | A message encrypted for a different auth secret fails to decrypt | Same |
| Dead subscriptions are recognisable | A 410 from the push service comes back as `gone: true` | Same |
| A real push service accepts our messages | Headed Chromium (Playwright, under Xvfb) subscribed through `/push-spike/index.html` and got a `jmt17.google.com/fcm/send/...` endpoint. The function's sends returned `201` for both a 110-byte notification and a 3993-byte payload | Edge runtime → FCM |
| Not shown | The notification appearing in that Chromium. `chrome://gcm-internals` shows the browser stuck in `Connection State: CONNECTING` to `mtalk.google.com`, which the sandbox network doesn't allow. FCM accepting a message doesn't check that it decrypts | n/a |

Re-run the offline proof any time (needs [Deno](https://deno.com) 2.x, no Docker):

```sh
deno run -A supabase/functions/push-spike/verify.ts
```

Through the edge runtime instead (from the repo root, local stack running):

```sh
pnpm db:start
# push.env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_SPIKE_ALLOW_HTTP=true
pnpm exec supabase functions serve push-spike --env-file push.env &
deno run -A --env-file=push.env supabase/functions/push-spike/verify.ts \
  --function-url http://127.0.0.1:55321/functions/v1/push-spike \
  --service-key "$(pnpm exec supabase status -o env | sed -n 's/^SERVICE_ROLE_KEY=//p' | tr -d '"')" \
  --host "$(docker network inspect supabase_network_queue-management -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}')"
```

`--host` is the docker bridge gateway, so the edge runtime container can reach the fake push service on your machine.

## Library choice

Designed twice (interface rule 7):

| | `jsr:@negrel/webpush` 0.5.0 (chosen) | `npm:web-push` 3.6.7 |
|---|---|---|
| Runtime APIs | WebCrypto and `fetch` only | Node `crypto`, `https`, `Buffer` through Deno's Node compatibility |
| Fits `packages/providers` rule "only what Deno and the browser can load" | Yes | No |
| Maturity | One maintainer, small; README says it hasn't had a crypto review | De facto standard, years of production use |
| In this spike | Works in the edge runtime; output verified independently | Encrypts under Deno 2.9; not run in the edge runtime. The `http_ece` package it depends on crashed on the decrypt path under Deno's Node compatibility (`createHmac` on a detached buffer), so Node-compat risk is real |

The maturity gap is the real cost of the choice. It's contained because the library sits behind one function (`sendWebPush` in `supabase/functions/_shared/web-push.ts`), and `verify.ts` checks its output against the RFCs rather than against itself. If it ever misbehaves, swapping to `npm:web-push` touches one file.

Two things the wrapper does on purpose:

- **A fresh application-server key pair per message.** The library keeps one ECDH key pair per `ApplicationServer` instance; RFC 8291 3.1 wants a new one per message, so `sendWebPush` creates an instance per send. It costs about a millisecond.
- **Push service answers are values, not exceptions.** `404`/`410` return `gone: true` (delete the subscription, never retry). Only caller mistakes (bad keys, payload over 3993 bytes) throw.

## Limits and rules for N4 (#70)

- **Payload: 3993 bytes of plaintext**, from the 4096-byte limit all push services share (FCM, Mozilla, Apple) minus the aes128gcm header (86 bytes with the 65-byte key id), the 16-byte tag and the padding delimiter. "You're up" messages are about 110 bytes, so this only matters if someone tries to push the whole queue.
- **Every push must show a notification.** Subscriptions are `userVisibleOnly`. Safari revokes the subscription after a few pushes that don't display one, and Chrome shows a generic "site updated in the background" notice.
- **TTL and urgency.** The spike uses `TTL: 3600`, `Urgency: high`. For "you're up" a short TTL (about 10 minutes) is better: a call delivered after the guest's turn has passed is worse than none. Use `Topic` (for example the visit id) so "almost up" is replaced by "you're up" instead of stacking.
- **VAPID subject** must be a real `mailto:` or `https:` URL. Apple rejects malformed subjects with `BadJwtToken`.
- **SSRF.** The function posts to whatever endpoint the subscription names. The spike only lets the service role call it. N4 should accept only `https` endpoints on known push hosts (`fcm.googleapis.com`, `*.google.com` for legacy FCM endpoints, `updates.push.services.mozilla.com`, `web.push.apple.com`, `*.notify.windows.com`) when `guest_register_push` stores them.
- **Keys.** Generate once with `npx web-push generate-vapid-keys` and store as Edge Function secrets (`supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=...`). Rotating them invalidates every existing subscription.

## iPhone (D1)

From Apple's documentation and WebKit release notes, not yet confirmed on a device here:

- Web push works on **iOS/iPadOS 16.4 and later, only for a web app added to the Home Screen** and opened from there. In a Safari tab, `PushManager` is missing entirely, so the subscribe page says so.
- The permission prompt must come from a tap (a user gesture), which the spike page does.
- Pushes arrive through `web.push.apple.com` with the same VAPID and encryption, so no Apple developer account or APNs certificate is needed.
- The page needs a web app manifest with `display: standalone`; the spike ships one at `/push-spike/manifest.webmanifest`.

This confirms the risk in technical-design.md: a walk-in guest who scanned a QR code in Safari can't get push at all until they add the page to their Home Screen. The send path being solved doesn't change D1.

## Device test (The maintainer)

You need HTTPS reachable from the phone. A free Cloudflare quick tunnel to your dev server works.

1. **Keys and function.** In the repo root:
   ```sh
   npx web-push generate-vapid-keys   # prints a public and a private key
   cat > supabase/functions/.env <<'EOF'
   VAPID_PUBLIC_KEY=<public key>
   VAPID_PRIVATE_KEY=<private key>
   VAPID_SUBJECT=mailto:<your email>
   EOF
   pnpm db:start
   pnpm exec supabase functions serve push-spike --env-file supabase/functions/.env
   ```
   `supabase/functions/.env` is ignored by git; never commit the private key.
2. **Page over HTTPS.** In another terminal:
   ```sh
   __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.trycloudflare.com pnpm dev
   cloudflared tunnel --url http://localhost:5173   # brew install cloudflared
   ```
   Open `https://<random>.trycloudflare.com/push-spike/index.html?key=<public key>` on the phone.
3. **Android Chrome.** Tap **Enable alerts**, allow notifications, tap **Copy**, and send the copied JSON to yourself (or paste it into a note on your laptop).
4. **iPhone (iOS 16.4+).** In Safari, open the same URL, then Share → **Add to Home Screen**. Open it from the Home Screen icon, tap **Enable alerts**, allow, and copy the JSON. Also try it in a normal Safari tab and note what the status line says.
5. **Send.** For each subscription, lock the phone, then from your laptop:
   ```sh
   curl -s -X POST http://127.0.0.1:55321/functions/v1/push-spike \
     -H "Authorization: Bearer $(pnpm exec supabase status -o env | sed -n 's/^SERVICE_ROLE_KEY=//p' | tr -d '"')" \
     -H 'Content-Type: application/json' \
     -d '{"subscription": <pasted JSON>}'
   ```
   Expect `{"ok":true,"status":201,...}` and a "You're up!" notification on the lock screen within a few seconds.
6. **Record** the result below with a screenshot of each lock screen in the PR.

Debugging: on desktop Chrome, `chrome://gcm-internals` shows received messages and a "Message Decryption Failure Log". A `403` from Apple or Google usually means the VAPID public key in the page doesn't match the function's key. A `410` means the subscription is gone: subscribe again.

| Device | OS / browser | Installed to Home Screen | Subscribed | Notification shown | Time to arrive | Notes |
|---|---|---|---|---|---|---|
| Android | | n/a | | | | |
| iPhone | | yes | | | | |
| iPhone | | no (Safari tab) | | n/a | n/a | |

## What gets thrown away

`supabase/functions/push-spike/` and `apps/web/public/push-spike/` are spike code. N4 (#70) keeps the shape of `sendWebPush` as the web push `NotificationChannel`, moves the `push` handler into the PWA service worker, and deletes both folders.
