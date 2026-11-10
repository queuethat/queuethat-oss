-- 2P-PRV1 (#188): retention. A daily job anonymizes guest data older than the org's retention
-- period and records what it did (C-9, X-4). Visits are never deleted (I-1): anonymizing is an
-- UPDATE with actor system, one 'anonymized' event without PII, and analytics fields untouched.

alter table app.organizations
  add column retention_days int not null default 30 check (retention_days between 1 and 3650);
alter table app.visits add column anonymized_at timestamptz;
alter table app.appointments add column anonymized_at timestamptz;

create table app.retention_runs (
  id bigint generated always as identity primary key,
  org_id uuid not null references app.organizations (id) on delete cascade,
  ran_at timestamptz not null default now(),
  visits_anonymized int not null,
  contacts_deleted int not null,
  appointments_anonymized int not null
);
create index retention_runs_org_idx on app.retention_runs (org_id, ran_at desc);
revoke insert, update, delete, truncate on app.retention_runs from authenticated;
alter table app.retention_runs enable row level security;
create policy retention_runs_select on app.retention_runs for select to authenticated
  using ((select private.has_role(org_id, null, 'admin')));

-- Second sanctioned exception to append-only (after the undo marker): with the transaction-local
-- flag only private.anonymize_visits sets, an event's payload may be rewritten, nothing else.
-- redefines private.guard_visit_event from 20261025000400_visits.sql
create or replace function private.guard_visit_event() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'visit_events is append-only' using errcode = '42501';
  end if;
  if current_setting('app.retention', true) = 'on'
     and (to_jsonb(new) - 'payload') = (to_jsonb(old) - 'payload') then
    return new;
  end if;
  if old.undone_by_event_id is not null
     or (to_jsonb(new) - 'undone_by_event_id') <> (to_jsonb(old) - 'undone_by_event_id') then
    raise exception 'visit_events is append-only' using errcode = '42501';
  end if;
  return new;
end $$;

/**
 * Removes every trace of who the given visits were for: name, phone, email, guest and contact
 * links, device key, PII keys in event payloads, notification variables. Keeps timestamps,
 * service, party size, status and quoted ETA, so statistics do not move. Already anonymized
 * visits are skipped, so repeating a call changes nothing. Returns visits changed.
 */
create function private.anonymize_visits(p_org_id uuid, p_visit_ids uuid[]) returns int
language plpgsql volatile set search_path = '' as $$
declare
  v_ids uuid[];
begin
  perform private.set_actor('system', null, 'anonymized', 'retention');
  with u as (
    update app.visits set guest_name = null, guest_id = null, contact_id = null,
                          guest_phone_e164 = null, guest_email = null, device_key_hash = null,
                          anonymized_at = now()
    where org_id = p_org_id and id = any (p_visit_ids) and anonymized_at is null
    returning id
  )
  select array_agg(id) into v_ids from u;
  if v_ids is null then
    return 0;
  end if;
  perform set_config('app.retention', 'on', true);
  update app.visit_events
  set payload = payload - array['name', 'guest_name', 'first_name', 'phone', 'phone_e164', 'email',
                                'contact', 'answers']
  where org_id = p_org_id and visit_id = any (v_ids);
  perform set_config('app.retention', '', true);
  update app.notifications set vars = '{}', recipient_hash = null
  where org_id = p_org_id and visit_id = any (v_ids);
  return cardinality(v_ids);
end $$;
comment on function private.anonymize_visits(uuid, uuid[]) is
  'Strips personal data from visits of one org (see body); one anonymized event each. Idempotent. '
  'Used by the retention job and guest erasure. Not exposed.';
revoke all on function private.anonymize_visits(uuid, uuid[]) from public, anon, authenticated;

create function private.anonymize_appointments(p_org_id uuid, p_ids uuid[]) returns int
language plpgsql volatile set search_path = '' as $$
declare
  n int;
begin
  perform private.set_actor('system', null, null, 'retention');
  update app.appointments set guest_name = '—', guest_id = null, contact_id = null, anonymized_at = now()
  where org_id = p_org_id and id = any (p_ids) and anonymized_at is null;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function private.anonymize_appointments(uuid, uuid[]) from public, anon, authenticated;

/**
 * Anonymizes, per org, up to 5000 visits and appointments that ended more than retention_days
 * ago, deletes the contacts and guests nothing live refers to, and records a retention_runs row
 * (also when nothing changed). Daily by pg_cron; returns visits anonymized. Not callable via the API.
 */
create function ops.retention_tick() returns int
language plpgsql volatile set search_path = '' as $$
declare
  o record;
  v_visits uuid[];
  v_appts uuid[];
  nv int;
  na int;
  nc int;
  total int := 0;
begin
  for o in select id, retention_days from app.organizations loop
    select coalesce(array_agg(id), '{}') into v_visits from (
      select v.id from app.visits v
      where v.org_id = o.id and v.anonymized_at is null
        and v.status in ('served', 'no_show', 'cancelled', 'removed', 'expired')
        and coalesce(v.finished_at, v.joined_at) < now() - make_interval(days => o.retention_days)
      limit 5000) s;
    select coalesce(array_agg(id), '{}') into v_appts from (
      select a.id from app.appointments a
      where a.org_id = o.id and a.anonymized_at is null
        and a.status in ('completed', 'cancelled', 'no_show')
        and a.ends_at < now() - make_interval(days => o.retention_days)
      limit 5000) s;
    nv := private.anonymize_visits(o.id, v_visits);
    na := private.anonymize_appointments(o.id, v_appts);

    with d as (
      delete from app.guests g
      where g.org_id = o.id
        and g.created_at < now() - make_interval(days => o.retention_days)
        and not exists (select 1 from app.visits v where v.guest_id = g.id and v.anonymized_at is null)
        and not exists (select 1 from app.appointments a where a.guest_id = g.id and a.anonymized_at is null)
      returning (select count(*) from app.guest_contacts c where c.guest_id = g.id) as contacts
    )
    select coalesce(sum(contacts), 0)::int into nc from d;

    insert into app.retention_runs (org_id, visits_anonymized, contacts_deleted, appointments_anonymized)
    values (o.id, nv, nc, na);
    total := total + nv;
  end loop;

  delete from app.dev_inbox where created_at < now() - interval '7 days';
  delete from app.push_subscriptions p using app.visits v
  where v.id = p.visit_id and v.status in ('served', 'no_show', 'cancelled', 'removed', 'expired')
    and coalesce(v.finished_at, v.joined_at) < now() - interval '1 day';
  return total;
end $$;
comment on function ops.retention_tick() is
  'Daily retention job (see body). Returns visits anonymized. Consent rows are kept with the '
  'contact link nulled and a hash of the value.';

select cron.schedule('retention-tick', '23 2 * * *', 'select ops.retention_tick()');
