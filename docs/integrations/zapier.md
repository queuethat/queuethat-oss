# Zapier integration

Zapier needs no app listing: use **Webhooks by Zapier** to catch events and call the API.

## 1. Catch events

1. Create a Zap with the trigger **Webhooks by Zapier → Catch Raw Hook** (raw, so the signature can be checked against the exact body).
2. Copy the catch URL into a new webhook endpoint in the admin console (kind `generic`), subscribe it to your events and keep the signing secret.
3. Add a step **Code by Zapier (JavaScript)** that verifies the signature before anything else runs:

```js
const crypto = require('crypto');
const secret = inputData.secret;            // map your signing secret as an input
const raw = inputData.raw_body;             // map the raw body of the catch hook
const header = inputData.signature;         // map the X-QM-Signature header
const parts = header.split(',').map((p) => p.trim().split('='));
const t = Number(parts.find(([k]) => k === 't')?.[1]);
const fresh = Number.isInteger(t) && Math.abs(Date.now() / 1000 - t) <= 300;
const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
const ok = fresh && parts.some(([k, v]) => k === 'v1' && v && v.length === expected.length &&
  crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected)));
if (!ok) throw new Error('bad signature');
return { event: JSON.parse(raw) };
```

Add a **Filter** step on `X-QM-Event-Id` if your downstream action must not run twice; delivery is at least once.

## 2. Call the API

Add **Webhooks by Zapier → Custom Request**: method POST, URL `https://<api-origin>/rest/v1/rpc/get_visit`, headers `apikey` (public key), `Content-Profile: api_v1`, `X-API-Key: qk_live_…`, `Content-Type: application/json`, body `{"p_visit_id": "<event.data.visit.id>"}`. The function list, scopes and error codes are in the [n8n guide](n8n.md#2-call-the-api-back); they are the same for any HTTP client.

The verification logic above is the same as the tested Node example in [`examples/verify-webhook.mjs`](examples/verify-webhook.mjs).
