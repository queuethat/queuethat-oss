-- N-11 (#255): channel fallback chain. Opt-in per template: a template with fallback_after_seconds
-- set makes its trigger send on the FIRST available, consented channel of the queue's channel_order;
-- the next channel is queued when that attempt dies, is suppressed, or misses its deadline, while
-- the message is still relevant. Templates without it behave as before (every channel at once).
-- Every hop is its own outbox row (chain_id, chain_step, its own dedupe key), so the delivery log shows
-- the chain. A message that is accepted just after its fallback was queued can arrive twice: bounded
-- by one hop per channel, and accepted.
alter table app.notification_templates add column fallback_after_seconds int
  check (fallback_after_seconds is null or fallback_after_seconds between 10 and 3600);
alter table app.queues add column channel_order text[] not null default '{push,telegram,sms,email}'
  check (channel_order <@ array['push', 'telegram', 'sms', 'email', 'whatsapp']);
alter table app.notifications add column chain_id uuid, add column chain_step int not null default 1,
  add column fallback_at timestamptz;
create index notifications_chain_idx on app.notifications (chain_id, chain_step) where chain_id is not null;
create index notifications_fallback_due_idx on app.notifications (fallback_at)
  where fallback_at is not null and status in ('queued', 'claimed', 'failed');
grant select (chain_id, chain_step, fallback_at) on app.notifications to authenticated;

/** Where a visit's message could go, one row per recipient; no template or consent applied. */
create function private.visit_recipients(p_visit app.visits, p_trigger text)
returns table (channel app.notification_channel, ref uuid)
language sql stable set search_path = '' as $$
  select 'push'::app.notification_channel as channel, s.id as ref
    from app.push_subscriptions s
    where s.visit_id = p_visit.id
    union all
    select case gc.channel when 'email' then 'email' else 'sms' end::app.notification_channel, gc.id
    from app.guest_contacts gc
    where gc.id = p_visit.contact_id and gc.org_id = p_visit.org_id
    union all
    -- A Telegram chat the guest linked from the status page (#252): its contact is the recipient.
    select 'telegram'::app.notification_channel, l.contact_id
    from app.channel_link_codes l
    where l.visit_id = p_visit.id and l.channel = 'telegram' and l.used_at is not null
      and l.contact_id is not null
    union all
    -- Online and kiosk joins keep what the guest typed on the visit (join_hardening); the visit
    -- itself is the recipient, so recipient_ref is the visit id. The address is unverified, so
    -- only the org's earliest live visit with it is mailed: repeated joins with someone else's
    -- address (or +tag and dot variants of it, canonical_email) send one visit's messages, not one
    -- per join.
    select ch.channel, p_visit.id
    from (values ('email'::app.notification_channel, p_visit.guest_email),
                 ('sms'::app.notification_channel, p_visit.guest_phone_e164)) ch (channel, value)
    where p_visit.contact_id is null and ch.value is not null
      -- Free text from staff never goes to an address a guest only typed (nobody verified it).
      and p_trigger <> 'broadcast'
      and not exists (
        select 1 from app.visits o
        where o.org_id = p_visit.org_id and o.id <> p_visit.id
          and o.status in ('waiting', 'called', 'serving')
          and case ch.channel when 'email' then private.canonical_email(o.guest_email)
                              else o.guest_phone_e164 end
              = case ch.channel when 'email' then private.canonical_email(ch.value) else ch.value end
          and (o.joined_at, o.id) < (p_visit.joined_at, p_visit.id))
$$;
revoke all on function private.visit_recipients(app.visits, text) from public, anon, authenticated;

/** The consent rule claim_outbox applies, for choosing a chain's channel up front. */
create function private.recipient_consented(
  p_channel app.notification_channel, p_ref uuid, p_visit app.visits, p_category app.message_category
) returns boolean
language sql stable set search_path = '' as $$
  select p_channel = 'push'
    -- An email typed at join consents to transactional mail about that visit (decision 20, #398).
    or (p_ref = p_visit.id and p_channel = 'email' and p_category = 'transactional')
    or coalesce((select c.status = 'granted' and c.revoked_at is null from app.consents c
                 where c.contact_id = p_ref and c.channel = p_channel and c.purpose = p_category
                 order by c.captured_at desc limit 1), false)
$$;
revoke all on function private.recipient_consented(app.notification_channel, uuid, app.visits, app.message_category)
  from public, anon, authenticated;

-- redefines private.enqueue_notification from 20261030171448_channel_link_codes.sql
create or replace function private.enqueue_notification(
  p_visit app.visits,
  p_event_id bigint,
  p_trigger text,
  p_scope text,
  p_vars jsonb default '{}'
) returns void
language sql volatile set search_path = '' as $$
  with cand as (
    select r.channel, r.ref, t.version, t.category, t.fallback_after_seconds as fb,
           t.fallback_after_seconds is not null
             and private.recipient_consented(r.channel, r.ref, p_visit, t.category) as chain_ok,
           array_position(q.channel_order, r.channel::text) as ord,
           jsonb_strip_nulls(jsonb_build_object('ticket', p_visit.display_ticket, 'counter', c.label)
                             || coalesce(p_vars, '{}')) as vars
    from private.visit_recipients(p_visit, p_trigger) r
    cross join lateral private.resolve_template(p_visit.org_id, p_visit.queue_id, p_trigger,
                                                r.channel, p_visit.locale) t
    left join app.counters c on c.id = p_visit.counter_id
    left join app.queues q on q.id = p_visit.queue_id
    -- The guest's alert choice: a trigger they switched off is never queued.
    where p_trigger = any (private.visit_alert_triggers(p_visit.id))
  ), ranked as (
    select cand.*, gen_random_uuid() as nid,
           case when chain_ok then row_number() over (partition by chain_ok order by ord nulls last, channel) end as rn
    from cand
  )
  insert into app.notifications (id, org_id, visit_id, event_id, channel, recipient_ref, template_key,
                                 template_version, category, vars, dedupe_key, chain_id, fallback_at)
  select k.nid, p_visit.org_id, p_visit.id, p_event_id, k.channel, k.ref, p_trigger, k.version, k.category,
         k.vars, concat_ws(':', p_scope, k.channel, k.ref),
         case when k.chain_ok then k.nid end,
         case when k.chain_ok then now() + make_interval(secs => k.fb) end
  from ranked k
  -- A chained template sends on its first consented channel only; the rest wait as fallbacks.
  where k.fb is null or (k.chain_ok and k.rn = 1)
  on conflict (dedupe_key) do nothing
$$;
comment on function private.enqueue_notification(app.visits, bigint, text, text, jsonb) is
  'Queues p_trigger for every recipient of the visit that has a template (push subscriptions, the '
  'visit''s contact, a linked Telegram chat, or the email and phone typed at join), unless the '
  'guest''s alert preferences leave it out. A template with fallback_after_seconds queues only the '
  'first consented channel of the queue''s channel_order, as step 1 of a chain (private.advance_chain '
  'adds the next). Snapshots the template version and {ticket, counter} plus p_vars. Idempotent per '
  '(p_scope, channel, recipient).';

/** Queues the next step of the chain n belongs to, if one is due and the message still matters. */
create function private.advance_chain(n app.notifications) returns void
language plpgsql volatile set search_path = '' as $$
declare
  v app.visits;
  nx record;
begin
  if n.chain_id is null or n.visit_id is null
     or exists (select 1 from app.notifications x where x.chain_id = n.chain_id and x.chain_step = n.chain_step + 1) then
    return;
  end if;
  -- A step with no fallback to make stops being due, so the sweep can't starve on it.
  if not api.outbox_still_relevant(n.id) then
    update app.notifications set fallback_at = null where id = n.id;
    return;
  end if;
  select * into v from app.visits where id = n.visit_id;
  select r.channel, r.ref, t.version, t.category, t.fallback_after_seconds as fb,
         array_position(q.channel_order, r.channel::text) as ord
  into nx
  from private.visit_recipients(v, n.template_key) r
  cross join lateral private.resolve_template(v.org_id, v.queue_id, n.template_key, r.channel, v.locale) t
  left join app.queues q on q.id = v.queue_id
  where private.recipient_consented(r.channel, r.ref, v, t.category)
    and array_position(q.channel_order, r.channel::text) > array_position(q.channel_order, n.channel::text)
  order by ord, r.channel
  limit 1;
  if not found then
    update app.notifications set fallback_at = null where id = n.id;
    return; -- nothing further to try
  end if;
  insert into app.notifications (org_id, visit_id, event_id, channel, recipient_ref, template_key, template_version,
                                 category, vars, dedupe_key, chain_id, chain_step, fallback_at)
  values (n.org_id, n.visit_id, n.event_id, nx.channel, nx.ref, n.template_key, nx.version, nx.category, n.vars,
          'chain:' || n.chain_id || ':' || (n.chain_step + 1), n.chain_id, n.chain_step + 1,
          case when nx.fb is not null then now() + make_interval(secs => nx.fb) end)
  on conflict (dedupe_key) do nothing;
end $$;
revoke all on function private.advance_chain(app.notifications) from public, anon, authenticated;

create function private.notification_chain_trigger() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform private.advance_chain(new);
  return null;
end $$;
revoke all on function private.notification_chain_trigger() from public, anon, authenticated;
-- A step that died (provider gone, dead letter, lease expiry) or was suppressed hands over at once.
create trigger notifications_advance_chain after update of status on app.notifications
  for each row when (new.chain_id is not null and new.status in ('dead', 'suppressed')
                     and old.status is distinct from new.status)
  execute function private.notification_chain_trigger();

/** Hands over the steps that missed their deadline (not sent in time) to the next channel. */
create function ops.advance_notification_chains() returns int
language plpgsql volatile set search_path = '' as $$
declare
  n app.notifications;
  v_count int := 0;
begin
  for n in
    select * from app.notifications x
    where x.fallback_at <= now() and x.status in ('queued', 'claimed', 'failed')
      and not exists (select 1 from app.notifications y where y.chain_id = x.chain_id and y.chain_step = x.chain_step + 1)
    order by x.fallback_at limit 200
  loop
    perform private.advance_chain(n);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
revoke all on function ops.advance_notification_chains() from public, anon, authenticated;
select cron.schedule('advance-notification-chains', '15 seconds', 'select ops.advance_notification_chains()');
