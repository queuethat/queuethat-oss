-- 2P-NTF1 (#173): per-visit alert preferences, enforced where messages are enqueued and again when
-- they are claimed. A visit with no row has the defaults (called, almost_up), so joining writes
-- nothing; the row is created by the guest's first change and follows the visit through a
-- transfer because it is keyed by visit, not queue.
--
-- Alternative rejected: a column on app.visits. It would widen the visit engine's row for a
-- notification concern, and every visit edit would then touch the table the guard trigger audits.

create table app.alert_preferences (
  org_id uuid not null,
  visit_id uuid primary key,
  triggers text[] not null default '{called,almost_up}',
  updated_at timestamptz not null default now(),
  foreign key (org_id, visit_id) references app.visits (org_id, id),
  check (triggers <@ array['called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast',
                           'removed', 'served'])
);
comment on table app.alert_preferences is
  'Which notification triggers a visit''s guest wants. No row means the defaults. Written only by '
  'api.guest_set_alert_prefs; staff read.';

create trigger forbid_org_change before update on app.alert_preferences
  for each row execute function private.forbid_org_change();
create trigger touch_updated_at before update on app.alert_preferences
  for each row execute function private.touch_updated_at();

revoke insert, update, delete, truncate on app.alert_preferences from authenticated;
alter table app.alert_preferences enable row level security;
create policy alert_preferences_select on app.alert_preferences for select to authenticated
  using ((select private.has_role(org_id, null, 'staff')));

------------------------------------------------------------------------------------------------
-- Helpers
------------------------------------------------------------------------------------------------

create function private.alert_trigger_names() returns text[]
language sql immutable set search_path = '' as $$
  select array['called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed', 'served']
$$;
comment on function private.alert_trigger_names() is
  'Every trigger a guest can opt in or out of. The one list the table check and the RPC share.';

create function private.visit_alert_triggers(p_visit_id uuid) returns text[]
language sql stable set search_path = '' as $$
  select coalesce((select p.triggers from app.alert_preferences p where p.visit_id = p_visit_id),
                  '{called,almost_up}')
$$;
comment on function private.visit_alert_triggers(uuid) is
  'The triggers the visit''s guest receives: their saved choice, else called and almost_up.';

-- Triggers the guest can usefully choose: those with a template for the visit's org and queue.
create function private.visit_alert_available(p_visit app.visits) returns text[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(n order by array_position(private.alert_trigger_names(), n)), '{}')
  from unnest(private.alert_trigger_names()) n
  where exists (
    select 1 from app.notification_templates t
    where t.trigger = n and (t.org_id is null or t.org_id = p_visit.org_id)
      and (t.queue_id is null or t.queue_id = p_visit.queue_id))
$$;
comment on function private.visit_alert_available(app.visits) is
  'The alert triggers that have a message template for the visit, in display order.';

revoke all on function private.alert_trigger_names() from public, anon, authenticated;
revoke all on function private.visit_alert_triggers(uuid) from public, anon, authenticated;
revoke all on function private.visit_alert_available(app.visits) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- Guest RPCs
------------------------------------------------------------------------------------------------

create type api.alert_prefs as (triggers text[], available text[]);

create function api.guest_get_alert_prefs(p_token text) returns api.alert_prefs
language plpgsql stable security definer set search_path = '' as $$
declare
  v app.visits;
begin
  if current_setting('request.method', true) = 'GET' then
    raise exception 'invalid_input' using detail = 'use POST';
  end if;
  v := private.visit_by_token(p_token);
  return (private.visit_alert_triggers(v.id), private.visit_alert_available(v))::api.alert_prefs;
end $$;
comment on function api.guest_get_alert_prefs(text) is
  'The alerts the token''s visit will send (triggers) and the ones it can choose from (available). '
  'Raises not_found for unknown or expired tokens as get_visit_status does, invalid_input on GET.';

create function api.guest_set_alert_prefs(p_token text, p_triggers text[], p_idempotency_key uuid)
returns api.alert_prefs
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  v_triggers text[];
begin
  if current_setting('request.method', true) = 'GET' then
    raise exception 'invalid_input' using detail = 'use POST';
  end if;
  if p_triggers is null or cardinality(p_triggers) > 32 then
    raise exception 'invalid_input';
  end if;
  -- No row lock on the visit: a guest repeating this call must not stall staff transitions.
  v := private.visit_by_token(p_token);
  if not p_triggers <@ private.alert_trigger_names() then
    raise exception 'invalid_trigger';
  end if;
  v_triggers := coalesce((select array_agg(n order by array_position(private.alert_trigger_names(), n))
                          from unnest(private.alert_trigger_names()) n where n = any (p_triggers)), '{}');
  insert into app.alert_preferences (org_id, visit_id, triggers)
  values (v.org_id, v.id, v_triggers)
  on conflict (visit_id) do update set triggers = excluded.triggers
  where app.alert_preferences.triggers is distinct from excluded.triggers;
  return (v_triggers, private.visit_alert_available(v))::api.alert_prefs;
end $$;
comment on function api.guest_set_alert_prefs(text, text[], uuid) is
  'Replaces the alerts the token''s visit receives with p_triggers (duplicates and order ignored; '
  'empty turns every alert off, including called: the status page stays the fallback and the UI '
  'warns). Takes effect for notifications not yet claimed. Setting the same list again is a '
  'no-op, so p_idempotency_key is accepted but not needed. Raises invalid_trigger for a name '
  'outside the known triggers, invalid_input for null or GET, not_found as guest_get_alert_prefs.';

revoke all on function api.guest_get_alert_prefs(text), api.guest_set_alert_prefs(text, text[], uuid)
  from public, anon, authenticated, service_role;
grant execute on function api.guest_get_alert_prefs(text), api.guest_set_alert_prefs(text, text[], uuid)
  to anon, authenticated, service_role;

------------------------------------------------------------------------------------------------
-- Enforcement: enqueue and send time
------------------------------------------------------------------------------------------------

-- redefines private.enqueue_notification from 20261025004600_mail_abuse_limits.sql
create or replace function private.enqueue_notification(
  p_visit app.visits,
  p_event_id bigint,
  p_trigger text,
  p_scope text
) returns void
language sql volatile set search_path = '' as $$
  insert into app.notifications (org_id, visit_id, event_id, channel, recipient_ref, template_key,
                                 template_version, category, vars, dedupe_key)
  select p_visit.org_id, p_visit.id, p_event_id, r.channel, r.ref, p_trigger, t.version, t.category,
         jsonb_strip_nulls(jsonb_build_object('ticket', p_visit.display_ticket, 'counter', c.label)),
         concat_ws(':', p_scope, r.channel, r.ref)
  from (
    select 'push'::app.notification_channel as channel, s.id as ref
    from app.push_subscriptions s
    where s.visit_id = p_visit.id
    union all
    select case gc.channel when 'email' then 'email' else 'sms' end::app.notification_channel, gc.id
    from app.guest_contacts gc
    where gc.id = p_visit.contact_id and gc.org_id = p_visit.org_id
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
      and not exists (
        select 1 from app.visits o
        where o.org_id = p_visit.org_id and o.id <> p_visit.id
          and o.status in ('expected', 'waiting', 'called', 'serving')
          and case ch.channel when 'email' then private.canonical_email(o.guest_email)
                              else o.guest_phone_e164 end
              = case ch.channel when 'email' then private.canonical_email(ch.value) else ch.value end
          and (o.joined_at, o.id) < (p_visit.joined_at, p_visit.id))
  ) r
  cross join lateral private.resolve_template(p_visit.org_id, p_visit.queue_id, p_trigger,
                                              r.channel, p_visit.locale) t
  left join app.counters c on c.id = p_visit.counter_id
  -- The guest's alert choice: a trigger they switched off is never queued.
  where p_trigger = any (private.visit_alert_triggers(p_visit.id))
  on conflict (dedupe_key) do nothing
$$;
comment on function private.enqueue_notification(app.visits, bigint, text, text) is
  'Queues p_trigger for every recipient of the visit that has a template: push subscriptions, and '
  'the visit''s contact, or without one the email and phone typed at join (recipient_ref = visit '
  'id) unless an earlier live visit in the org has the same address. Nothing is queued when the '
  'guest''s alert preferences leave p_trigger out. Snapshots the template version and '
  '{ticket, counter}. Idempotent per (p_scope, channel, recipient).';

-- redefines api.outbox_still_relevant from 20261025003800_account_emails.sql
create or replace function api.outbox_still_relevant(p_outbox_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce((
    select case
      -- Account mail is about something that already happened; it stays worth sending.
      when n.visit_id is null then true
      -- The guest turned this alert off after it was queued.
      when not n.template_key = any (private.visit_alert_triggers(n.visit_id)) then false
      -- The call must still stand: not undone, and not superseded by a later call or recall.
      when n.template_key = 'called' then v.status = 'called' and e.undone_by_event_id is null
        and not exists (select 1 from app.visit_events l
                        where l.visit_id = v.id and l.id > n.event_id and l.type in ('call', 'recall'))
      when n.template_key = 'almost_up' then v.status = 'waiting'
      else v.status in ('expected', 'waiting', 'called', 'serving')
    end
    from app.notifications n
    left join app.visits v on v.id = n.visit_id
    left join app.visit_events e on e.id = n.event_id
    where n.id = p_outbox_id
  ), false);
end $$;
comment on function api.outbox_still_relevant(uuid) is
  'False when sending would be wrong now: the guest turned the alert off, almost_up once the guest '
  'is no longer waiting, called after the call was undone, superseded by a newer call or the '
  'guest moved on, anything for a finished visit or an unknown id. Account mail is always still '
  'relevant. Implemented in N2 (#68), preferences in 2P-NTF1 (#173).';
