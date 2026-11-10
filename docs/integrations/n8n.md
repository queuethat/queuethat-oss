# n8n integration

Queue events reach n8n through a webhook; n8n calls the API back with an API key. No app listing is needed.

## 1. Receive events

1. In the admin console create a webhook endpoint (kind `generic`) pointing at your n8n Webhook URL and subscribe it to the events you want (for example `visit.called`). Copy the signing secret, shown once.
2. In n8n set the environment variables `QM_WEBHOOK_SECRET` (the signing secret), `QM_API_URL` (your API origin, for example `https://api.example.com`), `QM_ANON_KEY` (the project's public key) and `QM_API_KEY` (an API key with `visits:read`).
3. Import [`n8n/queue-events.workflow.json`](n8n/queue-events.workflow.json): Webhook (raw body on) → Code (verifies `X-QM-Signature`) → IF → HTTP Request (calls `api_v1.get_visit`).

Always verify the signature on the raw body. The header is `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. During a secret rotation it carries one `v1=` value per secret. Reject timestamps older than five minutes and dedupe on `X-QM-Event-Id`: delivery is at least once.

## 2. Call the API back

The API is Postgres functions behind PostgREST. Call them with **POST** (never GET), the schema in `Content-Profile`, and the key in `X-API-Key`:

```
POST {QM_API_URL}/rest/v1/rpc/get_visit
apikey: <public key>
Content-Profile: api_v1
X-API-Key: qk_live_…
Content-Type: application/json

{"p_visit_id": "…"}
```

Functions: `list_queues`, `get_queue`, `list_visits`, `get_visit` (scopes `queues:read`, `visits:read`) and, with write scopes, `create_visit`, `transition_visit` (pass the visit's current `version` as `p_expected_version`, and a fresh UUID as `p_idempotency_key`), `set_queue_state`. Errors come back as the message: `unauthorized`, `insufficient_scope`, `rate_limited` (600 requests a minute per key), `not_found`, `stale_visit`.

## Verifying in plain code

[`examples/verify-webhook.mjs`](examples/verify-webhook.mjs) (Node) and [`examples/verify_webhook.py`](examples/verify_webhook.py) (Python) are tested against payloads signed by the sender itself.
