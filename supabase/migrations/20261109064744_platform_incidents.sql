-- #1274 (C8): platform breach incident register (epic #1267, forms-privacy-design.md 8.1).
--
--   * Operator-only (aal2). The register holds who was affected and what we found, so support
--     agents do not see it. Tenants, devices and anon have no path to it.
--   * Incidents are never hard-deleted before five years after detection (a trigger, not a
--     convention); the timeline is append-only.
--   * The 72-hour notify clock runs from detected_at (conservative: counsel may move it to
--     "scope confirmed"). private.incident_clock is the one owner of that rule.
--   * The affected-tenant finder lists each scoped org's owners and, once C7 (app.org_privacy)
--     exists, its breach contact. private.org_breach_contact is the one seam; C7 needs no change here.
--   * The break-glass log is the platform_audit 'support.break_glass' rows for the scoped orgs.

create type app.incident_status as enum ('suspected', 'contained', 'resolved');

create table app.platform_incidents (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in (
    'unauthorized_access', 'data_exposure', 'credential_compromise', 'misdirected_message',
    'lost_device', 'vendor_incident', 'other')),
  title text not null check (length(btrim(title)) between 1 and 200),
  description text check (length(description) <= 4000),
  status app.incident_status not null default 'suspected',
  detected_at timestamptz not null default now(),
  -- Scope. Org ids are not foreign keys: the record outlives a purged tenant.
  org_ids uuid[] not null default '{}' check (cardinality(org_ids) <= 500),
  data_categories text[] not null default '{}' check (data_categories <@ array[
    'contact', 'visit_history', 'form_answers', 'sensitive_answers', 'payment', 'credentials', 'other']),
  record_count int check (record_count >= 0),
  containment text check (length(containment) <= 4000),
  root_cause text check (length(root_cause) <= 4000),
  lessons text check (length(lessons) <= 4000),
  -- Set once, when the affected tenants have been told (C9 sets it when a notice is sent).
  notified_at timestamptz,
  -- Or why no notice is owed (for example, no tenant data was reached).
  notice_waived_reason text check (length(btrim(notice_waived_reason)) between 1 and 500),
  created_by uuid references auth.users (id) on delete set null,
  idempotency_key uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (created_by, idempotency_key)
);
create index platform_incidents_detected_idx on app.platform_incidents (detected_at desc);

create table app.platform_incident_events (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references app.platform_incidents (id) on delete cascade,
  kind text not null check (kind in ('created', 'note', 'status', 'scope', 'containment', 'notified', 'waived')),
  body text check (length(body) <= 4000),
  actor_id uuid references auth.users (id) on delete set null,
  -- clock_timestamp, not now(): events in one transaction still sort in the order they happened.
  created_at timestamptz not null default clock_timestamp()
);
create index platform_incident_events_idx on app.platform_incident_events (incident_id, created_at);

-- Five-year retention: an incident can be deleted only once it is older than that; the timeline
-- cannot change, except when its incident goes with it.
create function private.forbid_incident_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and old.detected_at < now() - interval '5 years' then
    return old;
  end if;
  raise exception 'platform_incidents are kept for five years' using errcode = '42501';
end $$;
create trigger forbid_delete before delete on app.platform_incidents
  for each row execute function private.forbid_incident_delete();
create trigger forbid_truncate before truncate on app.platform_incidents
  for each statement execute function private.forbid_incident_delete();

create function private.forbid_incident_event_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from app.platform_incidents i where i.id = old.incident_id) then
    return old;
  end if;
  raise exception 'platform_incident_events is append-only' using errcode = '42501';
end $$;
create trigger forbid_change before update or delete on app.platform_incident_events
  for each row execute function private.forbid_incident_event_change();
create trigger forbid_truncate before truncate on app.platform_incident_events
  for each statement execute function private.forbid_incident_event_change();

revoke all on app.platform_incidents, app.platform_incident_events from anon, authenticated, service_role;
grant select on app.platform_incidents, app.platform_incident_events to authenticated;
alter table app.platform_incidents enable row level security;
alter table app.platform_incident_events enable row level security;
create policy platform_incidents_select on app.platform_incidents for select to authenticated
  using ((select private.is_platform('operator')));
create policy platform_incident_events_select on app.platform_incident_events for select to authenticated
  using ((select private.is_platform('operator')));

------------------------------------------------------------------------------------------------
-- The clock and the tenant seam
------------------------------------------------------------------------------------------------

/** Hours tenants must be told within, counted from detection. The one owner of the number. */
create function private.incident_notify_hours() returns int
language sql immutable set search_path = '' as $$ select 72 $$;

/** The breach contact C7 stores for an org, or null while C7 is absent or the org has none. */
create function private.org_breach_contact(p_org_id uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v jsonb;
begin
  if to_regclass('app.org_privacy') is null then
    return null;
  end if;
  execute 'select jsonb_build_object(''name'', p.officer_name, ''email'', p.email, ''phone'', p.phone) '
          'from app.org_privacy p where p.org_id = $1' into v using p_org_id;
  return v;
end $$;

------------------------------------------------------------------------------------------------
-- API
------------------------------------------------------------------------------------------------

create type api.platform_incident as (
  id uuid,
  kind text,
  title text,
  description text,
  status app.incident_status,
  detected_at timestamptz,
  org_ids uuid[],
  data_categories text[],
  record_count int,
  containment text,
  root_cause text,
  lessons text,
  notified_at timestamptz,
  notice_waived_reason text,
  -- detected_at + 72 hours.
  notify_due_at timestamptz,
  -- 'done' (told or waived), 'pending', or 'overdue'.
  notify_state text,
  -- True while the notice is overdue: the flag the console raises.
  escalated boolean,
  created_at timestamptz,
  updated_at timestamptz,
  -- detected_at + 5 years: the earliest the record can be deleted.
  retain_until timestamptz
);
create type api.platform_incident_tenant as (
  org_id uuid,
  org_name text,
  -- Null when the org has been purged since the incident was filed.
  owners jsonb,
  -- {name, email, phone}, or null until the tenant has set one (C7).
  breach_contact jsonb
);
create type api.platform_incident_break_glass as (
  at timestamptz,
  org_id uuid,
  org_name text,
  operator_email text,
  reason text,
  support_grant_id uuid
);
grant usage on type app.incident_status, api.platform_incident, api.platform_incident_tenant,
  api.platform_incident_break_glass to authenticated;

create function private.incident_row(i app.platform_incidents) returns api.platform_incident
language sql stable set search_path = '' as $$
  select i.id, i.kind, i.title, i.description, i.status, i.detected_at, i.org_ids, i.data_categories,
    i.record_count, i.containment, i.root_cause, i.lessons, i.notified_at, i.notice_waived_reason,
    i.detected_at + make_interval(hours => private.incident_notify_hours()),
    case when i.notified_at is not null or i.notice_waived_reason is not null then 'done'
         when now() > i.detected_at + make_interval(hours => private.incident_notify_hours()) then 'overdue'
         else 'pending' end,
    i.notified_at is null and i.notice_waived_reason is null
      and now() > i.detected_at + make_interval(hours => private.incident_notify_hours()),
    i.created_at, i.updated_at, i.detected_at + interval '5 years'
$$;

create function private.incident_event(p_id uuid, p_kind text, p_body text) returns void
language sql volatile set search_path = '' as $$
  insert into app.platform_incident_events (incident_id, kind, body, actor_id)
  values (p_id, p_kind, p_body, (select auth.uid()))
$$;

create function api.platform_create_incident(
  p_kind text,
  p_title text,
  p_detected_at timestamptz default null,
  p_description text default null,
  p_org_ids uuid[] default '{}',
  p_data_categories text[] default '{}',
  p_record_count int default null,
  p_idempotency_key uuid default null
) returns api.platform_incident
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v app.platform_incidents;
begin
  perform private.require_platform('operator');
  if p_idempotency_key is not null then
    select * into v from app.platform_incidents where created_by = v_uid and idempotency_key = p_idempotency_key;
    if found then
      return private.incident_row(v);
    end if;
  end if;
  begin
    insert into app.platform_incidents
      (kind, title, description, detected_at, org_ids, data_categories, record_count, created_by, idempotency_key)
    values (p_kind, btrim(coalesce(p_title, '')), nullif(btrim(p_description), ''),
      coalesce(p_detected_at, now()), coalesce((select array_agg(distinct o) from unnest(p_org_ids) o), '{}'),
      coalesce((select array_agg(distinct c) from unnest(p_data_categories) c), '{}'), p_record_count,
      v_uid, p_idempotency_key)
    returning * into v;
  exception when check_violation or not_null_violation then
    raise exception 'invalid_input';
  end;
  if v.detected_at > now() + interval '5 minutes' then
    raise exception 'invalid_input';
  end if;
  perform private.incident_event(v.id, 'created', v.title);
  perform private.platform_audit('incident.create', null, jsonb_build_object('incident_id', v.id, 'kind', v.kind), null);
  return private.incident_row(v);
end $$;
comment on function api.platform_create_incident(text, text, timestamptz, text, uuid[], text[], int, uuid) is
  'Operator with aal2: files an incident (status suspected, detected now unless given) and starts '
  'its 72-hour notify clock. Repeating p_idempotency_key returns the same incident. A bad kind, '
  'category, blank title, negative count or a detection time in the future raises invalid_input; '
  'permission_denied (42501) without operator and aal2. Audited without the text.';

create function api.platform_update_incident(
  p_id uuid,
  p_status app.incident_status default null,
  p_org_ids uuid[] default null,
  p_data_categories text[] default null,
  p_record_count int default null,
  p_containment text default null,
  p_root_cause text default null,
  p_lessons text default null,
  p_mark_notified boolean default false,
  p_waive_reason text default null
) returns api.platform_incident
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.platform_incidents;
  o app.platform_incidents;
begin
  perform private.require_platform('operator');
  select * into o from app.platform_incidents where id = p_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  begin
    update app.platform_incidents i set
      status = coalesce(p_status, i.status),
      org_ids = coalesce((select array_agg(distinct x) from unnest(p_org_ids) x), i.org_ids),
      data_categories = coalesce((select array_agg(distinct x) from unnest(p_data_categories) x), i.data_categories),
      record_count = coalesce(p_record_count, i.record_count),
      containment = coalesce(nullif(btrim(p_containment), ''), i.containment),
      root_cause = coalesce(nullif(btrim(p_root_cause), ''), i.root_cause),
      lessons = coalesce(nullif(btrim(p_lessons), ''), i.lessons),
      notified_at = case when coalesce(p_mark_notified, false) then coalesce(i.notified_at, now()) else i.notified_at end,
      notice_waived_reason = coalesce(nullif(btrim(p_waive_reason), ''), i.notice_waived_reason),
      updated_at = now()
    where i.id = p_id returning * into v;
  exception when check_violation then
    raise exception 'invalid_input';
  end;
  if v.status is distinct from o.status then
    perform private.incident_event(p_id, 'status', v.status::text);
  end if;
  if (v.org_ids, v.data_categories, v.record_count) is distinct from (o.org_ids, o.data_categories, o.record_count) then
    perform private.incident_event(p_id, 'scope', format('%s orgs, %s records', cardinality(v.org_ids), coalesce(v.record_count::text, '?')));
  end if;
  if v.containment is distinct from o.containment then
    perform private.incident_event(p_id, 'containment', v.containment);
  end if;
  if v.notified_at is distinct from o.notified_at then
    perform private.incident_event(p_id, 'notified', null);
  end if;
  if v.notice_waived_reason is distinct from o.notice_waived_reason then
    perform private.incident_event(p_id, 'waived', v.notice_waived_reason);
  end if;
  perform private.platform_audit('incident.update', null, jsonb_build_object('incident_id', p_id, 'status', v.status), null);
  return private.incident_row(v);
end $$;
comment on function api.platform_update_incident(uuid, app.incident_status, uuid[], text[], int, text, text, text, boolean, text) is
  'Operator with aal2: changes the given fields (null leaves one as it is; scope arrays replace) '
  'and records what changed on the timeline. p_mark_notified stamps notified_at once; '
  'p_waive_reason records why no notice is owed. Both stop the clock. Raises not_found for an '
  'unknown incident, invalid_input for a bad category or count, permission_denied (42501) '
  'without operator and aal2.';

create function api.platform_add_incident_note(p_id uuid, p_body text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_platform('operator');
  if length(btrim(coalesce(p_body, ''))) not between 1 and 4000 then
    raise exception 'invalid_input';
  end if;
  if not exists (select 1 from app.platform_incidents where id = p_id) then
    raise exception 'not_found';
  end if;
  perform private.incident_event(p_id, 'note', btrim(p_body));
end $$;
comment on function api.platform_add_incident_note(uuid, text) is
  'Operator with aal2: appends a note to the incident timeline. Raises invalid_input for a blank '
  'or over-4000-character note, not_found for an unknown incident, permission_denied (42501) '
  'without operator and aal2.';

create function api.platform_list_incidents(p_status app.incident_status default null, p_id uuid default null)
returns setof api.platform_incident
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform('operator');
  return query
  select (private.incident_row(i)).* from app.platform_incidents i
  where (p_status is null or i.status = p_status) and (p_id is null or i.id = p_id)
  order by i.detected_at desc, i.id
  limit 200;
end $$;
comment on function api.platform_list_incidents(app.incident_status, uuid) is
  'Operator with aal2: incidents newest first (at most 200), optionally of one status or one id, '
  'each with its notify deadline, state and escalation flag. Raises permission_denied (42501) '
  'without operator and aal2.';

create function api.platform_incident_tenants(p_id uuid) returns setof api.platform_incident_tenant
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform('operator');
  if not exists (select 1 from app.platform_incidents where id = p_id) then
    raise exception 'not_found';
  end if;
  return query
  select x.org_id, o.name, 
    (select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email) order by u.email)
       from app.memberships m join auth.users u on u.id = m.user_id
      where m.org_id = x.org_id and m.role = 'owner'),
    private.org_breach_contact(x.org_id)
  from app.platform_incidents i
  cross join lateral unnest(i.org_ids) as x(org_id)
  left join app.organizations o on o.id = x.org_id
  where i.id = p_id
  order by o.name, x.org_id;
end $$;
comment on function api.platform_incident_tenants(uuid) is
  'Operator with aal2: the incident''s scoped orgs with their owners and breach contact (null until '
  'the tenant sets one). Raises not_found for an unknown incident, permission_denied (42501) '
  'without operator and aal2.';

create function api.platform_incident_break_glass(p_id uuid) returns setof api.platform_incident_break_glass
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform('operator');
  if not exists (select 1 from app.platform_incidents where id = p_id) then
    raise exception 'not_found';
  end if;
  return query
  select a.at, a.org_id, o.name, u.email::text, a.reason, (a.target ->> 'support_grant_id')::uuid
  from app.platform_incidents i
  join app.platform_audit a on a.org_id = any (i.org_ids) and a.action = 'support.break_glass'
    and a.at >= i.detected_at - interval '30 days'
  left join app.organizations o on o.id = a.org_id
  left join auth.users u on u.id = a.actor_id
  where i.id = p_id
  order by a.at desc;
end $$;
comment on function api.platform_incident_break_glass(uuid) is
  'Operator with aal2: break-glass openings on the incident''s orgs from 30 days before detection, '
  'newest first, with the operator and reason. Raises not_found for an unknown incident, '
  'permission_denied (42501) without operator and aal2.';

revoke all on function api.platform_create_incident(text, text, timestamptz, text, uuid[], text[], int, uuid),
  api.platform_update_incident(uuid, app.incident_status, uuid[], text[], int, text, text, text, boolean, text),
  api.platform_add_incident_note(uuid, text),
  api.platform_list_incidents(app.incident_status, uuid),
  api.platform_incident_tenants(uuid),
  api.platform_incident_break_glass(uuid) from public, anon;
grant execute on function api.platform_create_incident(text, text, timestamptz, text, uuid[], text[], int, uuid),
  api.platform_update_incident(uuid, app.incident_status, uuid[], text[], int, text, text, text, boolean, text),
  api.platform_add_incident_note(uuid, text),
  api.platform_list_incidents(app.incident_status, uuid),
  api.platform_incident_tenants(uuid),
  api.platform_incident_break_glass(uuid) to authenticated;
revoke all on function private.incident_row(app.platform_incidents), private.incident_event(uuid, text, text),
  private.incident_notify_hours(), private.org_breach_contact(uuid),
  private.forbid_incident_delete(), private.forbid_incident_event_change() from public, anon, authenticated;
