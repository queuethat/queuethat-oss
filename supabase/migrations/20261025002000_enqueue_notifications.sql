-- N2 (#68): visit events enqueue notifications in the same transaction (technical-design.md 3.4).
--
-- Phase 1 has two triggers: `called` (every call or recall) and `almost_up` (once per visit, when
-- it reaches the first queues.almost_up_threshold waiting places). Rows are written for every
-- recipient the visit has: each push subscription, and its contact (email -> email, phone ->
-- sms). A channel is live when a template resolves for it, so SMS stays off until SMS templates
-- exist. Consent, suppression and quiet hours are not checked here: claim_outbox resolves the
-- facts and the provider policy (packages/providers policy.ts) decides, so a guest without
-- consent gets a visible `suppressed` row rather than silence.

alter table app.queues
  add column almost_up_threshold int not null default 2 check (almost_up_threshold between 1 and 20);
comment on column app.queues.almost_up_threshold is
  'A waiting guest gets one "almost up" message on reaching this place in line or better.';

------------------------------------------------------------------------------------------------
-- Template resolution
------------------------------------------------------------------------------------------------

create function private.resolve_template(
  p_org_id uuid,
  p_queue_id uuid,
  p_trigger text,
  p_channel app.notification_channel,
  p_locale text
) returns setof app.notification_templates
language sql stable set search_path = '' as $$
  select t.*
  from app.notification_templates t
  where t.trigger = p_trigger and t.channel = p_channel
    and t.locale in (p_locale, 'en')
    and (t.org_id is null or t.org_id = p_org_id)
    and (t.queue_id is null or t.queue_id = p_queue_id)
  order by t.locale = p_locale desc, t.queue_id is not null desc, t.org_id is not null desc
  limit 1
$$;
comment on function private.resolve_template(uuid, uuid, text, app.notification_channel, text) is
  'The template a message uses: the guest''s locale before English, then queue over org over '
  'system default. No row means the channel is not offered for that trigger.';

------------------------------------------------------------------------------------------------
-- Enqueue
------------------------------------------------------------------------------------------------

/**
 * Inserts one queued row per recipient of p_visit for p_trigger. The dedupe key is
 * p_scope:channel:recipient, so repeating a scope never adds a row.
 */
create function private.enqueue_notification(
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
  ) r
  cross join lateral private.resolve_template(p_visit.org_id, p_visit.queue_id, p_trigger,
                                              r.channel, p_visit.locale) t
  left join app.counters c on c.id = p_visit.counter_id
  on conflict (dedupe_key) do nothing
$$;
comment on function private.enqueue_notification(app.visits, bigint, text, text) is
  'Queues p_trigger for every recipient of the visit that has a template, snapshotting the '
  'template version and {ticket, counter}. Idempotent per (p_scope, channel, recipient).';

create function private.enqueue_for_event() returns trigger
language plpgsql set search_path = '' as $$
declare
  v app.visits;
  w app.visits;
  threshold int;
begin
  select * into v from app.visits where id = new.visit_id;

  if new.type in ('call', 'recall') then
    perform private.enqueue_notification(v, new.id, 'called', 'e' || new.id);
  end if;

  -- A join only pushes others back and the joiner just saw its place; rollover ends the day.
  if new.type in ('joined', 'expire') then
    return null;
  end if;

  select q.almost_up_threshold into threshold from app.queues q where q.id = v.queue_id;
  for w in
    select * from app.visits x
    where x.queue_id = v.queue_id and x.service_day = v.service_day and x.status = 'waiting'
    order by x.sort_key, x.id
    limit threshold
  loop
    perform private.enqueue_notification(w, new.id, 'almost_up', 'almost_up:' || w.id);
  end loop;
  return null;
end $$;
comment on function private.enqueue_for_event() is
  'AFTER INSERT on app.visit_events: queues `called` for call and recall events and `almost_up` '
  'for waiting visits now within the queue''s threshold, in the event''s transaction. Visits '
  'that move out of range and back are not messaged twice.';

create trigger enqueue_notifications after insert on app.visit_events
  for each row execute function private.enqueue_for_event();

------------------------------------------------------------------------------------------------
-- Kicking the dispatcher
------------------------------------------------------------------------------------------------

/**
 * Asks pg_net to POST to the dispatch-notifications function once per transaction. pg_net sends
 * after commit, so a rolled-back transaction kicks nothing. Unconfigured (no vault secret
 * `dispatcher_url`) it does nothing, and it never fails the caller's transaction.
 */
create function private.kick_dispatcher() returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_url text;
  v_key text;
begin
  if current_setting('app.dispatcher_kicked', true) = 'on' then
    return;
  end if;
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'dispatcher_url';
  if v_url is null then
    return;
  end if;
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'dispatcher_key';
  perform net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || coalesce(v_key, ''))
  );
  perform set_config('app.dispatcher_kicked', 'on', true);
exception when others then
  raise warning 'kick_dispatcher failed: %', sqlerrm;
end $$;
comment on function private.kick_dispatcher() is
  'Requests one dispatcher run after this transaction commits. Configure with vault secrets '
  'dispatcher_url and dispatcher_key (service role key). Never raises.';

create function private.kick_dispatcher_on_insert() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from inserted) then
    perform private.kick_dispatcher();
  end if;
  return null;
end $$;

-- Transition table: an enqueue that hit only duplicates inserts nothing and kicks nothing.
create trigger kick_dispatcher after insert on app.notifications
  referencing new table as inserted
  for each statement execute function private.kick_dispatcher_on_insert();

create function ops.kick_dispatcher_if_due() returns boolean
language plpgsql volatile set search_path = '' as $$
begin
  if not exists (
    select 1 from app.notifications n
    where (n.status in ('queued', 'failed') and n.next_attempt_at <= now())
       or (n.status = 'claimed' and n.locked_until < now())
  ) then
    return false;
  end if;
  perform private.kick_dispatcher();
  return true;
end $$;
comment on function ops.kick_dispatcher_if_due() is
  'Kicks the dispatcher when a row is due (queued or failed past next_attempt_at, or a claim '
  'whose lease expired). Run every 15 s by pg_cron; returns whether it kicked.';

select cron.schedule('kick-dispatcher', '15 seconds', 'select ops.kick_dispatcher_if_due()');

------------------------------------------------------------------------------------------------
-- api.outbox_still_relevant (signature and grants from S5, 20261025000600_api_contracts.sql)
------------------------------------------------------------------------------------------------

create or replace function api.outbox_still_relevant(p_outbox_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce((
    select case n.template_key
      -- The call must still stand: not undone, and not superseded by a later call or recall.
      when 'called' then v.status = 'called' and e.undone_by_event_id is null
        and not exists (select 1 from app.visit_events l
                        where l.visit_id = v.id and l.id > n.event_id and l.type in ('call', 'recall'))
      when 'almost_up' then v.status = 'waiting'
      else v.status in ('expected', 'waiting', 'called', 'serving')
    end
    from app.notifications n
    join app.visits v on v.id = n.visit_id
    left join app.visit_events e on e.id = n.event_id
    where n.id = p_outbox_id
  ), false);
end $$;
comment on function api.outbox_still_relevant(uuid) is
  'False when sending would be wrong now: almost_up once the guest is no longer waiting, called '
  'after the call was undone, superseded by a newer call or the guest moved on, anything for a '
  'finished visit or an unknown id. Implemented in N2 (#68).';

revoke all on function private.resolve_template(uuid, uuid, text, app.notification_channel, text) from public, anon, authenticated;
revoke all on function private.enqueue_notification(app.visits, bigint, text, text) from public, anon, authenticated;
revoke all on function private.enqueue_for_event() from public, anon, authenticated;
revoke all on function private.kick_dispatcher() from public, anon, authenticated;
revoke all on function private.kick_dispatcher_on_insert() from public, anon, authenticated;
revoke all on function ops.kick_dispatcher_if_due() from public, anon, authenticated;
