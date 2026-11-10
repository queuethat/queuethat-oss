# Square integration

A served visit upserts a Square customer (matched by phone or email) and appends a visit note to it. Only guests whose
contact holds a **granted marketing consent** are synced, and a consent withdrawn after the visit stops the sync.
Transactional consent never covers it. Each org brings its own Square application, so there is no platform-wide Square
credential; self-hosters and hosted orgs set it up the same way. Toast is not supported (it needs a partner program).

## Set up

1. In the Square Developer Dashboard create an application. Note the **Application ID** and **Application secret**.
2. Under Webhooks add a subscription for `oauth.authorization.revoked`. The notification URL is
   `<PUBLIC_FUNCTIONS_URL>/provider-webhook/square/<endpoint_id>` (the endpoint id is on the saved `pos` provider
   settings). Copy its **Signature key**.
3. Save the connection with `api.set_provider_settings(org, 'pos', 'square', 'own', {"application_id": "...", "environment": "production"}, {"application_secret": "...", "signing_secret": "<signature key>"}, key)`. Use `"environment": "sandbox"` to test.
4. Register the SPA return page as the application's OAuth redirect URL. The page calls the `square-oauth` function with
   `{action: "start", org_id}` to get the Square URL, then with `{action: "finish", state, code}` when Square redirects back.
   A successful finish stores the tokens in Vault and marks the connection verified.
5. An owner switches it on with `api.set_channel_enabled(org, 'pos', true, key)`.

## Operating it

- Deploy `integration-sync` with `DISPATCH_SECRET` and set the Vault secret `integration_sync_url` to its URL so the
  database can kick it; pg_cron also calls it every minute.
- Failed syncs retry after 1, 3, 9 ... 240 minutes and are dead-lettered after the sixth attempt (`app.integration_jobs`,
  visible to owners and admins). Errors are short codes (`unauthorized`, `http_503`), never Square response bodies.
- If the seller revokes the app, Square's signed `oauth.authorization.revoked` event deletes the tokens and disables the
  connection.
- Access tokens are refreshed automatically when less than 24 hours remain.

## Data handling

The sync sends the consenting guest's phone or email, first name as typed, and a note with the queue name, ticket and date to the org's own Square account. It is a deliberate exception to the "outbound messages go through the outbox" rule, because it is a data sync, not a message to the guest. Deleting or anonymising a guest here does **not** remove their Square customer; the seller does that in Square. The guest must have a verified contact and a granted marketing consent. Day-end auto-closed visits are not synced.
