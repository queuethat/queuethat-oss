-- 2B-I10 (#315): chat alerts. Slack, Discord and Teams endpoints get vendor-formatted bodies (the
-- sender formats them), two derived events (queue.long, delivery.dead), per-endpoint thresholds and a
-- vendor host check at creation. Staff channels only: payloads carry no contact data.

alter table app.webhook_endpoints drop constraint webhook_endpoints_event_types_check;
alter table app.webhook_endpoints add constraint webhook_endpoints_event_types_check check (
  cardinality(event_types) > 0
  and event_types <@ array['visit.joined', 'visit.called', 'visit.recalled', 'visit.serving', 'visit.served',
    'visit.no_show', 'visit.cancelled', 'visit.removed', 'visit.requeued', 'visit.expired',
    'visit.reinstated', 'visit.checked_in', 'queue.state_changed', 'queue.long', 'delivery.dead']::text[]);

-- {"waiting": n} alerts when more than n visits wait; {"wait_minutes": m} when the longest wait exceeds m.
alter table app.webhook_endpoints add column alert_thresholds jsonb not null default '{}'
  check (jsonb_typeof(alert_thresholds) = 'object');
grant select (alert_thresholds) on app.webhook_endpoints to authenticated;

create function private.webhook_url_fits_kind(p_kind text, p_url text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(case p_kind
    when 'slack' then h = 'hooks.slack.com'
    when 'discord' then h in ('discord.com', 'discordapp.com') and p_url ~* '^https://[^/]+/api/webhooks/'
    when 'teams' then h ~ '(^|\.)(webhook\.office\.com|logic\.azure\.com|powerplatform\.com)$'
    else true end, false)
  from (select lower(substring(lower(p_url) from '^https://([^/:?#]+)(?::443)?(?:[/?#]|$)')) as h) x
$$;
revoke all on function private.webhook_url_fits_kind(text, text) from public, anon, authenticated;

-- redefines api.create_webhook_endpoint from 20261030174831_webhooks.sql
create or replace function api.create_webhook_endpoint(p_org_id uuid, p_url text, p_kind text, p_event_types text[],
                                                       p_include_guest_name boolean, p_idempotency_key uuid)
returns api.webhook_endpoint_created
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  result api.webhook_endpoint_created;
  s record;
  v_id uuid := gen_random_uuid();
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if not exists (select 1 from app.memberships m where m.user_id = uid and m.org_id = p_org_id) then
    raise exception 'not_found';
  end if;
  if not private.is_org_admin_unrestricted(p_org_id) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_url is null or p_kind is null or p_event_types is null
     or cardinality(p_event_types) = 0 then
    raise exception 'invalid_input';
  end if;
  if p_url !~ '^https://[^@[:space:]]+$'
     and not (p_url ~ '^http://[^@[:space:]]+$' and (select d.allow_http_webhooks from private.deployment_settings d)) then
    raise exception 'invalid_url';
  end if;
  if p_kind not in ('generic', 'slack', 'discord', 'teams')
     or (select count(*) from app.webhook_endpoints e where e.org_id = p_org_id) >= 10 then
    raise exception 'invalid_input';
  end if;
  if not private.webhook_url_fits_kind(p_kind, p_url) then raise exception 'invalid_url'; end if;

  insert into app.idempotency_keys (org_id, actor_id, rpc, key)
  values (p_org_id, uid, 'create_webhook_endpoint', p_idempotency_key) on conflict do nothing;
  if not found then
    select r.id, null::text into result
    from app.idempotency_keys k, lateral jsonb_populate_record(null::api.webhook_endpoint_created, k.response) r
    where k.actor_id = uid and k.rpc = 'create_webhook_endpoint' and k.key = p_idempotency_key and k.org_id = p_org_id;
    return result;
  end if;

  select * into s from private.new_webhook_secret(v_id);
  begin
    insert into app.webhook_endpoints (id, org_id, url, kind, event_types, include_guest_name, vault_secret_id, created_by)
    values (v_id, p_org_id, p_url, p_kind, p_event_types, coalesce(p_include_guest_name, false), s.vault_id, uid);
  exception when check_violation then
    raise exception 'invalid_input';
  end;
  result := (v_id, s.secret);
  update app.idempotency_keys set response = jsonb_build_object('id', v_id)
  where actor_id = uid and rpc = 'create_webhook_endpoint' and key = p_idempotency_key;
  return result;
end $$;
comment on function api.create_webhook_endpoint(uuid, text, text, text[], boolean, uuid) is
  'Registers a webhook endpoint and returns its signing secret once (a repeat with the same idempotency '
  'key returns the id and a null secret). Owner or admin. Raises not_found for a non-member, '
  'permission_denied for a manager or staff, invalid_url unless the URL is https (http only when the '
  'deployment allows it) or a slack, discord or teams endpoint points anywhere but that vendor''s webhook host, invalid_input for an unknown kind or event type.';


create function api.set_webhook_alert_thresholds(p_endpoint_id uuid, p_thresholds jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  e app.webhook_endpoints;
begin
  select * into e from app.webhook_endpoints where id = p_endpoint_id for update;
  if not found or not exists (select 1 from app.memberships m where m.user_id = (select auth.uid()) and m.org_id = e.org_id) then
    raise exception 'not_found';
  end if;
  if not private.is_org_admin_unrestricted(e.org_id) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_thresholds is null or jsonb_typeof(p_thresholds) <> 'object'
     or exists (select 1 from jsonb_each(p_thresholds) t
                where t.key not in ('waiting', 'wait_minutes') or jsonb_typeof(t.value) <> 'number'
                   or t.value::text !~ '^[0-9]{1,5}$' or (t.value::text)::int < 1) then
    raise exception 'invalid_input';
  end if;
  update app.webhook_endpoints set alert_thresholds = p_thresholds where id = e.id;
end $$;
comment on function api.set_webhook_alert_thresholds(uuid, jsonb) is
  'Sets when an endpoint gets queue.long alerts: {"waiting": n} (more than n waiting) and/or '
  '{"wait_minutes": m} (longest wait over m minutes); {} turns them off. Owner or admin. '
  'Raises not_found, permission_denied, invalid_input.';
revoke all on function api.set_webhook_alert_thresholds(uuid, jsonb) from public, anon;
grant execute on function api.set_webhook_alert_thresholds(uuid, jsonb) to authenticated, service_role;

-- queue.long: one delivery per endpoint and queue, at most one per 30 minutes, evaluated every minute.
create function ops.evaluate_queue_long() returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  n int;
begin
  with q as (
    select e.id as endpoint_id, e.org_id, e.alert_thresholds t, qu.id as queue_id, qu.name, qu.location_id,
           count(v.id)::int as waiting, coalesce(extract(epoch from now() - min(v.joined_at)) / 60, 0) as longest
    from app.webhook_endpoints e
    join app.queues qu on qu.org_id = e.org_id and qu.archived_at is null
    join app.visits v on v.queue_id = qu.id and v.status = 'waiting'
    where e.active and 'queue.long' = any (e.event_types) and e.alert_thresholds <> '{}'
    group by e.id, e.org_id, e.alert_thresholds, qu.id, qu.name, qu.location_id
  ), hit as (
    select * from q
    where (t ? 'waiting' and waiting > (t ->> 'waiting')::int)
       or (t ? 'wait_minutes' and longest > (t ->> 'wait_minutes')::int)
  ), ins as (
    insert into app.webhook_deliveries (org_id, endpoint_id, event_id, event_type, payload)
    select h.org_id, h.endpoint_id, 'ql:' || h.queue_id || ':' || extract(epoch from now())::bigint, 'queue.long',
           jsonb_build_object('id', 'ql:' || h.queue_id || ':' || extract(epoch from now())::bigint, 'type', 'queue.long',
             'api_version', 'v1', 'occurred_at', now(),
             'data', jsonb_build_object('queue', jsonb_build_object('id', h.queue_id, 'location_id', h.location_id,
               'name', h.name, 'waiting_count', h.waiting, 'threshold', coalesce((h.t ->> 'waiting')::int, (h.t ->> 'wait_minutes')::int))))
    from hit h
    where not exists (select 1 from app.webhook_deliveries d
                      where d.endpoint_id = h.endpoint_id and d.event_type = 'queue.long'
                        and d.payload #>> '{data,queue,id}' = h.queue_id::text
                        and d.created_at > now() - interval '30 minutes')
    returning 1
  )
  select count(*)::int into n from ins;
  if n > 0 then perform private.kick_webhooks(); end if;
  return n;
end $$;
comment on function ops.evaluate_queue_long() is
  'pg_cron every minute: queues over an endpoint''s alert_thresholds get a queue.long delivery, at most one per endpoint and queue per 30 minutes. Returns the number queued.';
revoke all on function ops.evaluate_queue_long() from public, anon, authenticated;
select cron.schedule('evaluate-queue-long', '* * * * *', 'select ops.evaluate_queue_long()');

-- delivery.dead: a guest message gave up. Operational facts only (channel, category), never the recipient.
create function private.webhook_notification_dead() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.enqueue_webhooks(new.org_id, 'nd:' || new.id, 'delivery.dead', now(), null,
    jsonb_build_object('notification', jsonb_build_object('channel', new.channel, 'category', new.category)));
  return null;
end $$;
revoke all on function private.webhook_notification_dead() from public, anon, authenticated;
create trigger webhook_notification_dead after update on app.notifications
  for each row when (old.status is distinct from new.status and new.status = 'dead')
  execute function private.webhook_notification_dead();

notify pgrst, 'reload schema';
