# HubSpot integration

A served visit upserts a HubSpot contact (matched by email or phone) and adds a note to its timeline. Only guests with a
**verified contact and a granted marketing consent** are synced; a consent withdrawn after the visit, or a suppression
on the address, stops it. Each org brings its own HubSpot app, so there is no platform-wide HubSpot credential.
Salesforce and two-way sync are out of scope. If an n8n recipe is enough for you, see [n8n](n8n.md) instead.

## Set up

1. In HubSpot create a public app with the scopes `crm.objects.contacts.read` and `crm.objects.contacts.write`. Note the
   **Client ID**, **Client secret** and set the redirect URL to the signed-in SPA's return page.
2. Save the connection with `api.set_provider_settings(org, 'crm', 'hubspot', 'own', {"application_id": "<client id>", "redirect_uri": "<redirect URL>"}, {"application_secret": "<client secret>"}, key)`.
3. The return page calls the `hubspot-oauth` function with `{action: "start", org_id}` to get the HubSpot URL, then with
   `{action: "finish", state, code}` when HubSpot redirects back. A successful finish stores the tokens in Vault and
   marks the connection verified.
4. An owner switches it on with `api.set_channel_enabled(org, 'crm', true, key)`.

## Operating it

The queue, retries (1, 3, 9 ... 240 minutes, dead after the sixth) and the `integration-sync` worker are shared with
[Square](square.md). Access tokens last 30 minutes and are refreshed automatically. HubSpot stores phone numbers as
typed, so a phone lookup only matches contacts saved in E.164 form; email matches exactly.

## Data handling

The sync sends the consenting guest's email or phone, first name as typed, and a note with the queue name, ticket and
date to the org's own HubSpot. It is a deliberate exception to the "outbound messages go through the outbox" rule
because it is a data sync, not a message to the guest. Deleting or anonymising a guest here does not remove their
HubSpot contact; the org does that in HubSpot.
