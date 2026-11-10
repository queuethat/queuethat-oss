-- C3 (#1269): retention is capped by a platform setting (hosted = 365) and new orgs default to 365.
-- Expand-only (I-12): existing values are never shortened by this migration. Orgs above the cap are
-- listed by ops.retention_preclamp_report(); ops.clamp_retention() shortens them only on purpose.
--
-- Alternatives considered: a CHECK against a constant (self-hosters would have to fork), and a
-- trigger reading a new platform_settings table (a second singleton beside platform_flags). The cap
-- is a column on app.platform_flags, enforced by a trigger because a CHECK cannot read another table.

alter table app.platform_flags
  add column max_retention_days int not null default 365 check (max_retention_days >= 1);
comment on column app.platform_flags.max_retention_days is
  'Longest retention_days any org may set. Hosted deployments keep 365; self-hosters may raise it.';

alter table app.organizations alter column retention_days set default 365;

/**
 * Refuses a retention_days above the platform cap on insert and whenever the value changes.
 * Definer because no tenant role may read app.platform_flags.
 */
create function private.enforce_retention_cap() returns trigger
language plpgsql stable security definer set search_path = '' as $$
begin
  if (tg_op = 'INSERT' or new.retention_days is distinct from old.retention_days)
     and new.retention_days > (select max_retention_days from app.platform_flags) then
    raise exception 'retention_over_cap' using detail = (select max_retention_days::text from app.platform_flags);
  end if;
  return new;
end $$;
revoke all on function private.enforce_retention_cap() from public, anon, authenticated;

create trigger enforce_retention_cap before insert or update of retention_days on app.organizations
  for each row execute function private.enforce_retention_cap();

/** Orgs whose stored retention exceeds the platform cap: tell these owners before clamping. */
create function ops.retention_preclamp_report()
returns table (org_id uuid, org_name text, retention_days int, max_retention_days int)
language sql stable set search_path = '' as $$
  select o.id, o.name, o.retention_days, f.max_retention_days
  from app.organizations o cross join app.platform_flags f
  where o.retention_days > f.max_retention_days
  order by o.retention_days desc, o.id
$$;
comment on function ops.retention_preclamp_report() is
  'Orgs whose retention_days is above the platform cap. Read-only; not callable via the API.';

/**
 * Shortens every org above the platform cap to the cap and returns how many. Refuses with
 * retention_clamp_pending while any org is over the cap unless p_force is true, so a clamp is
 * never a side effect of a deploy. Shortening brings the next purge forward: run the report first.
 */
create function ops.clamp_retention(p_force boolean default false) returns int
language plpgsql volatile set search_path = '' as $$
declare
  n int;
begin
  if not p_force and exists (select 1 from ops.retention_preclamp_report()) then
    raise exception 'retention_clamp_pending';
  end if;
  update app.organizations set retention_days = (select max_retention_days from app.platform_flags)
  where retention_days > (select max_retention_days from app.platform_flags);
  get diagnostics n = row_count;
  return n;
end $$;
comment on function ops.clamp_retention(boolean) is
  'Clamps orgs above the platform cap; raises retention_clamp_pending unless p_force. Not callable via the API.';
revoke all on function ops.retention_preclamp_report() from public, anon, authenticated;
revoke all on function ops.clamp_retention(boolean) from public, anon, authenticated;

-- redefines private.anonymize_visits from 20261030175652_visit_chat.sql: also deletes intake answers
create or replace function private.anonymize_visits(p_org_id uuid, p_visit_ids uuid[]) returns int
language plpgsql volatile set search_path = '' as $$
declare
  v_ids uuid[];
begin
  perform private.set_actor('system', null, 'anonymized', 'retention');
  with u as (
    update app.visits set guest_name = null, guest_id = null, contact_id = null,
                          guest_phone_e164 = null, guest_email = null, device_key_hash = null,
                          notes = null, tags = '{}', anonymized_at = now()
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
  delete from app.visit_companions where org_id = p_org_id and visit_id = any (v_ids);
  delete from app.visit_messages where org_id = p_org_id and visit_id = any (v_ids);
  delete from app.visit_answers where org_id = p_org_id and visit_id = any (v_ids);
  update app.visit_feedback set comment = null where org_id = p_org_id and visit_id = any (v_ids);
  return cardinality(v_ids);
end $$;
comment on function private.anonymize_visits(uuid, uuid[]) is
  'Strips personal data from visits of one org (see body), notes, companions, chat messages, intake '
  'answers and feedback comments included; one anonymized event each. Idempotent. Used by the '
  'retention job and guest erasure. Not exposed.';
