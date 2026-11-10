-- #1083 follow-up: the payment emails link into the admin console. The dispatcher fills {app_url} from
-- PUBLIC_URL for account mail only; without it the optional bracketed sentence is dropped and the plain
-- path in the text still tells the owner where to go. Only the two system templates change; org overrides do not exist for them.

update app.notification_templates
set body = replace(body, E'\n\n[Not you,', E'\n\n[Open Billing: {app_url}/admin/billing]\n\n[Not you,')
where org_id is null and queue_id is null and channel = 'email'
  and trigger in ('payment_failed', 'payment_grace_ending')
  and body not like '%{app_url}%';
