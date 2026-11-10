-- 2P-NTF8 (#180): a manager sends one message to everyone waiting or called in a queue.
--
-- Still one outbox row per recipient, through private.enqueue_notification, so alert preferences,
-- consent, suppression and quiet hours apply exactly as for any other message. A mass-message
-- button is an abuse and cost surface once paid channels exist, so it is manager-only,
-- rate-limited per queue, length-limited and audited (the audit trigger on app.queue_broadcasts).
--
-- The staff text may use {{ticket}} and {{eta_range}} only. It is rendered here, per guest, into
-- the notification's `message` variable, and the system `broadcast` templates just print
-- {{message}}: the shared renderer never expands a substituted value again, which is what keeps a
-- guest-visible string from smuggling in other variables.

create table app.queue_broadcasts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  queue_id uuid not null,
  body text not null check (length(body) between 1 and 320),
  sent_by uuid references auth.users (id) on delete set null,
  recipients int not null default 0,
  suppressed int not null default 0,
  created_at timestamptz not null default now(),
  foreign key (org_id, queue_id) references app.queues (org_id, id)
);
create index queue_broadcasts_queue_idx on app.queue_broadcasts (queue_id, created_at desc);
comment on table app.queue_broadcasts is
  'One row per api.send_queue_message: the text, who sent it and how many guests it reached or skipped.';
create trigger forbid_org_change before update on app.queue_broadcasts
  for each row execute function private.forbid_org_change();
create trigger audit_row after insert or update or delete on app.queue_broadcasts
  for each row execute function private.audit_row();
revoke insert, update, delete, truncate on app.queue_broadcasts from authenticated;
alter table app.queue_broadcasts enable row level security;
-- Managers (who can send them) read the history; staff of any location would otherwise read
-- other locations' announcements.
create policy queue_broadcasts_select on app.queue_broadcasts for select to authenticated
  using ((select private.has_role(org_id, null, 'manager')));

------------------------------------------------------------------------------------------------
-- Defaults: broadcasts are on, and have a system template
------------------------------------------------------------------------------------------------

-- The venue's own "running late" notice is one guests expect; without it in the defaults the
-- feature would reach only guests who had opened the alerts sheet.
alter table app.alert_preferences
  alter column triggers set default '{called,almost_up,position_changed,eta_changed,broadcast}';

-- redefines private.visit_alert_triggers from 20261030073001_renotify.sql
create or replace function private.visit_alert_triggers(p_visit_id uuid) returns text[]
language sql stable set search_path = '' as $$
  select coalesce((select p.triggers from app.alert_preferences p where p.visit_id = p_visit_id),
                  '{called,almost_up,position_changed,eta_changed,broadcast}')
$$;
comment on function private.visit_alert_triggers(uuid) is
  'The triggers the visit''s guest receives: their saved choice, else called, almost_up, the '
  'position and estimate updates and the venue''s announcements.';

insert into app.notification_templates (trigger, channel, subject, body)
values ('broadcast', 'push', null, '{{message}}'),
       ('broadcast', 'console', null, '{{message}}'),
       ('broadcast', 'email', 'A message from the venue',
        E'{{message}}\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]');

------------------------------------------------------------------------------------------------
-- Free text only reaches push and stored contacts
------------------------------------------------------------------------------------------------

-- redefines private.enqueue_notification from 20261030073001_renotify.sql
create or replace function private.enqueue_notification(
  p_visit app.visits,
  p_event_id bigint,
  p_trigger text,
  p_scope text,
  p_vars jsonb default '{}'
) returns void
language sql volatile set search_path = '' as $$
  insert into app.notifications (org_id, visit_id, event_id, channel, recipient_ref, template_key,
                                 template_version, category, vars, dedupe_key)
  select p_visit.org_id, p_visit.id, p_event_id, r.channel, r.ref, p_trigger, t.version, t.category,
         jsonb_strip_nulls(jsonb_build_object('ticket', p_visit.display_ticket, 'counter', c.label)
                           || coalesce(p_vars, '{}')),
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
      -- Free text from staff never goes to an address a guest only typed (nobody verified it).
      and p_trigger <> 'broadcast'
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
comment on function private.enqueue_notification(app.visits, bigint, text, text, jsonb) is
  'Queues p_trigger for every recipient of the visit that has a template: push subscriptions, and '
  'the visit''s contact, or without one the email and phone typed at join (recipient_ref = visit '
  'id) unless an earlier live visit in the org has the same address; broadcasts skip that last '
  'kind of recipient entirely. Nothing is queued when the '
  'guest''s alert preferences leave p_trigger out. Snapshots the template version and '
  '{ticket, counter} plus p_vars (no contact data). Idempotent per (p_scope, channel, recipient).';

------------------------------------------------------------------------------------------------
-- api.send_queue_message
------------------------------------------------------------------------------------------------

create type api.broadcast_result as (broadcast_id uuid, recipients int, suppressed int);

create function api.send_queue_message(p_queue_id uuid, p_body text, p_idempotency_key uuid)
returns api.broadcast_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  q app.queues;
  uid uuid := (select auth.uid());
  blocked text;
  claim record;
  v_body text := btrim(coalesce(p_body, ''));
  bad text;
  b app.queue_broadcasts;
  w app.visits;
  eta record;
  vars jsonb;
  n_recipients int := 0;
  n_suppressed int := 0;
  result api.broadcast_result;
begin
  select * into q from app.queues where id = p_queue_id and archived_at is null;
  if not found or not private.has_role(q.org_id, q.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if not private.has_role(q.org_id, q.location_id, 'manager') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  blocked := private.write_blocked_reason(q.org_id, 'staff', uid);
  if blocked is not null then
    raise exception '%', blocked using errcode = '42501';
  end if;
  if p_idempotency_key is null or length(v_body) not between 1 and 320 then
    raise exception 'invalid_input';
  end if;
  if private.template_malformed(v_body) then
    raise exception 'unknown_variable' using detail = 'malformed placeholder';
  end if;
  select u into bad from unnest(private.template_used_variables(v_body)) u
  where u <> all (private.template_variables('broadcast')) order by u limit 1;
  if bad is not null then
    raise exception 'unknown_variable' using detail = bad;
  end if;

  select * into claim from private.claim_idempotent(q.org_id, 'send_queue_message', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.broadcast_result, claim.response);
  end if;
  -- One sender at a time per queue, so concurrent calls cannot all see 5 and pass the cap.
  perform pg_advisory_xact_lock(hashtextextended(q.id::text, 0));
  if (select count(*) from app.queue_broadcasts x
      where x.queue_id = q.id and x.created_at > now() - interval '1 hour') >= 6 then
    raise exception 'rate_limited';
  end if;

  insert into app.queue_broadcasts (org_id, queue_id, body, sent_by)
  values (q.org_id, q.id, v_body, uid)
  returning * into b;

  for w in
    select * from app.visits x
    where x.queue_id = q.id and x.service_day = private.service_day(q.location_id)
      and x.status in ('waiting', 'called')
    order by x.sort_key, x.id
  loop
    select * into eta from private.visit_eta(w.id);
    vars := jsonb_build_object('message',
      regexp_replace(regexp_replace(v_body, '\{\{\s*ticket\s*\}\}', w.display_ticket, 'g'),
                     '\{\{\s*eta_range\s*\}\}',
                     coalesce(eta.eta_low || '–' || eta.eta_high || ' min', 'a few minutes'), 'g'));
    perform private.enqueue_notification(w, null, 'broadcast', 'broadcast:' || b.id, vars);
    if exists (select 1 from app.notifications nn
               where nn.visit_id = w.id and nn.dedupe_key like 'broadcast:' || b.id || ':%') then
      n_recipients := n_recipients + 1;
    else
      n_suppressed := n_suppressed + 1;
    end if;
  end loop;

  update app.queue_broadcasts set recipients = n_recipients, suppressed = n_suppressed where id = b.id;
  result := (b.id, n_recipients, n_suppressed);
  perform private.save_idempotent('send_queue_message', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.send_queue_message(uuid, text, uuid) is
  'Sends p_body (1-320 characters; {{ticket}} and {{eta_range}} are the only variables) to every '
  'waiting or called guest of the queue through the outbox: guests who opted out of broadcasts or '
  'have nobody to send to are counted as suppressed, and consent, suppression and quiet hours are '
  'applied when each row is sent. Manager or above of the queue''s location. Records and audits the '
  'broadcast. Repeating an idempotency key returns the first result. Raises not_found (unknown '
  'queue or another tenant''s), permission_denied (42501, staff below manager), invalid_input, '
  'unknown_variable, rate_limited (more than 6 per queue per hour). A suspended org or a read-only support grant is denied as permission_denied.';

revoke all on function api.send_queue_message(uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function api.send_queue_message(uuid, text, uuid) to authenticated;
