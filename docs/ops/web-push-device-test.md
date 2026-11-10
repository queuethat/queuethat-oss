# Web push device test (N5, #71)

Manual check of the guest alert flow on real phones: join, tap **Alert me when it's my turn**, lock
the phone, staff calls the guest, a notification arrives, and tapping it opens the guest's
`/v/:token` page. Unit tests cover the parts that don't need a phone (`pushRouting.test.ts` for the
service worker's notification and click routing, `PushOptIn.test.tsx` for the opt-in states).

## Setup (once)

You need HTTPS reachable from the phone and a production build (the service worker is not
registered by `pnpm dev`).

1. **Keys.** `npx web-push generate-vapid-keys`. Never commit the private key.
2. **Dispatcher.** In `supabase/functions/.env` (ignored by git):
   ```sh
   VAPID_PUBLIC_KEY=<public key>
   VAPID_PRIVATE_KEY=<private key>
   VAPID_SUBJECT=mailto:<your email>
   DISPATCH_SECRET=<32+ random characters>
   ```
   Then `pnpm db:start` and
   `pnpm exec supabase functions serve dispatch-notifications --env-file supabase/functions/.env`.
   Point the database's kick at it (Vault secrets `dispatcher_url` =
   `http://host.docker.internal:55321/functions/v1/dispatch-notifications`, `dispatcher_key` = the
   same `DISPATCH_SECRET`), or POST to the function yourself after the call with
   `Authorization: Bearer <DISPATCH_SECRET>`.
3. **Web app.** In `apps/web/.env.local`, add `VITE_VAPID_PUBLIC_KEY=<public key>` (public key
   only). Then `pnpm build && pnpm -C apps/web exec vite preview --host` and
   `cloudflared tunnel --url http://localhost:4173`.

## Steps

| # | Device | Steps | Expect |
|---|---|---|---|
| 1 | Android Chrome | Open `https://<tunnel>/q/demo-barber`, join, tap **Alert me when it's my turn**, allow | "Alerts are on" |
| 2 | Android Chrome | Close the tab, lock the phone. As `staff@demo.test`, call the guest | A notification within seconds (acceptance criterion 1) |
| 3 | Android Chrome | Tap the notification | Chrome opens that guest's status page showing "Called" |
| 4 | iPhone Safari tab | Join, look under the wait estimate | Home Screen hint, no button |
| 5 | iPhone (iOS 16.4+) | Share → Add to Home Screen, open the icon | The status page opens (not the home page) with **Alert me** |
| 6 | iPhone Home Screen app | Tap **Alert me**, allow, lock, have staff call the guest, tap the notification | Notification arrives and opens the status page |
| 7 | Any | Deny the permission prompt | "Notifications are blocked…", page keeps working |
| 8 | Desktop Chrome, fresh profile | Tap **Alert me** | "Allow notifications in the browser prompt" while the prompt is up; after 5 s of setup "This can take up to a minute"; after 60 s with no push service answer, "took too long" and the button works again (#521) |

Record OS, browser and timings in the PR, with lock-screen screenshots. Step 5 depends on the
manifest having no `start_url` (the icon opens the page it was added from). If an iPhone opens the
home page instead, that is a bug to report: the guest's link would be lost.

Debugging: `chrome://gcm-internals` on desktop Chrome shows received pushes. A 403 from the push
service means the page's public key doesn't match the dispatcher's private key.
