-- PLT3 (#409): support access is granted by the org owner, not taken (technical-design.md 3.6).
--
--   * app.support_grants: an owner grants the platform's support staff 'read' or 'act' access for
--     1-72 hours. A second live grant replaces the first. Break-glass is the operator's own
--     read-only, one-hour grant with a written reason, for abuse and legal requests.
--   * private.has_role is the only place access is decided: a platform user (support or operator,
--     aal2) with a live grant passes staff-level checks ('read') or checks up to admin ('act');
--     never owner. Expiry is evaluated at call time, so no cleanup job exists.
--   * Nobody is impersonated. Writes run as the operator; the visit event and audit triggers
--     record actor_kind 'platform' and the grant id.
--   * private.write_blocked_reason owns "may this staff actor write here": the visit guard and
--     set_queue_state call it, because staff RPCs pass has_role at staff level, which a 'read'
--     grant (and a suspended org, PLT2) also passes.

alter type app.actor_kind add value if not exists 'platform';

create type app.support_scope as enum ('read', 'act');
grant usage on type app.support_scope to authenticated, service_role;

create table app.support_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  -- The owner, or the operator for break-glass.
  granted_by uuid references auth.users (id) on delete set null,
  -- null = every platform support user; break-glass names the operator who opened it.
  grantee uuid references auth.users (id) on delete cascade,
  scope app.support_scope not null,
  reason text not null check (length(btrim(reason)) between 1 and 500),
  break_glass boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  check (expires_at > created_at and expires_at <= created_at + interval '72 hours'),
  check (not break_glass
         or (scope = 'read' and grantee is not null and expires_at <= created_at + interval '1 hour'))
);
create index support_grants_live_idx on app.support_grants (org_id) where revoked_at is null;
-- One owner grant per org that is not revoked (grant_support_access revokes the previous one, even
-- if it already expired), so concurrent grants cannot leave two live.
create unique index support_grants_one_owner_grant on app.support_grants (org_id)
  where revoked_at is null and not break_glass;

create trigger forbid_org_change before update on app.support_grants
  for each row execute function private.forbid_org_change();
create trigger audit_row after insert or update or delete on app.support_grants
  for each row execute function private.audit_row();

-- Which grant an audit row's change came through. visit_events carry it in payload.
alter table app.audit_log add column support_grant_id uuid;

------------------------------------------------------------------------------------------------
-- Access helpers
------------------------------------------------------------------------------------------------

/**
 * The live grant through which the caller reaches p_org_id: the caller is a platform user with
 * an aal2 session, not a member of the org, and the grant is unrevoked, unexpired and open to
 * them. 'act' wins over 'read'. All columns null when there is none.
 */
create function private.support_grant(p_org_id uuid) returns app.support_grants
language sql stable set search_path = '' as $$
  select g.*
  from app.support_grants g
  where g.org_id = p_org_id
    and g.revoked_at is null
    and g.expires_at > now()
    and (g.grantee is null or g.grantee = (select auth.uid()))
    and not exists (
      select 1 from app.memberships m where m.org_id = p_org_id and m.user_id = (select auth.uid())
    )
    and private.is_platform('support')
  order by g.scope = 'act' desc, g.expires_at desc
  limit 1
$$;
comment on function private.support_grant(uuid) is
  'The live support grant the caller (a non-member platform user with aal2) holds for the org, '
  '''act'' before ''read''; all-null when none. Expiry is checked at call time.';

create or replace function private.has_role(p_org_id uuid, p_location_id uuid, p_min_role app.member_role)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from app.memberships m
    join app.organizations o on o.id = m.org_id
    where m.user_id = (select auth.uid())
      and m.org_id = p_org_id
      and m.role >= p_min_role
      and (m.location_ids is null or p_location_id is null or p_location_id = any (m.location_ids))
      and (o.status = 'active' or p_min_role = 'staff')
  ) or exists (
    select 1
    from private.support_grant(p_org_id) g
    join app.organizations o on o.id = g.org_id
    where g.id is not null
      and case g.scope when 'act' then p_min_role <= 'admin' else p_min_role = 'staff' end
      and (o.status = 'active' or p_min_role = 'staff')
  )
$$;
comment on function private.has_role(uuid, uuid, app.member_role) is
  'True when the caller is a member of the org with at least p_min_role. With a location, the '
  'membership must cover it (location_ids null = all). With p_location_id null, any membership '
  'in the org counts. A platform user with a live support grant (private.support_grant) passes '
  'staff-level checks with ''read'' and checks up to admin with ''act'', at every location; '
  'never owner. When the org is not active (suspended or pending_deletion), only staff-level '
  'checks pass; every manager-level or higher check fails. Staff-level checks also admit reads, '
  'so writes behind them are refused by private.write_blocked_reason. The only role check '
  'policies and api functions use.';

/**
 * Why a staff or device actor may not write to p_org_id now, or null when it may:
 * 'org_suspended' when the org is not active; 'permission_denied' when a staff actor is not a
 * member and holds no live 'act' grant. A null actor id is a fixture or migration run as the
 * database owner (API callers always have one).
 */
create function private.write_blocked_reason(p_org_id uuid, p_actor_kind text, p_actor_id uuid)
returns text
language sql stable set search_path = '' as $$
  select case
    when exists (select 1 from app.organizations o where o.id = p_org_id and o.status <> 'active')
      then 'org_suspended'
    when p_actor_kind = 'staff' and p_actor_id is not null
         and not exists (select 1 from app.memberships m where m.org_id = p_org_id and m.user_id = p_actor_id)
         and (private.support_grant(p_org_id)).scope is distinct from 'act'
      then 'permission_denied'
  end
$$;
comment on function private.write_blocked_reason(uuid, text, uuid) is
  'Why a staff or device actor may not write to the org now (org_suspended, permission_denied), '
  'or null. The one write check behind staff-level has_role: guard_visit and set_queue_state.';

------------------------------------------------------------------------------------------------
-- Write paths (bodies from 20261025002300 / 0400, with the write check generalised)
------------------------------------------------------------------------------------------------

create or replace function private.guard_visit() returns trigger
language plpgsql set search_path = '' as $$
declare
  act text := private.current_action();
  target api.visit_state;
  blocked text;
begin
  if nullif(current_setting('app.actor_kind', true), '') is null then
    raise exception 'missing_actor_context'
      using hint = 'Visits change only through api.* functions, which call private.set_actor().';
  end if;

  -- Staff and devices need an active org, and staff need membership or an 'act' grant. Guests and
  -- the system are not checked here.
  if current_setting('app.actor_kind') in ('staff', 'device') then
    blocked := private.write_blocked_reason(new.org_id, current_setting('app.actor_kind'),
                                            nullif(current_setting('app.actor_id', true), '')::uuid);
    if blocked is not null then
      raise exception '%', blocked using errcode = '42501';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if new.status not in ('waiting', 'expected') then
      raise exception 'illegal_transition' using detail = format('a visit cannot start as %s', new.status);
    end if;
    new.version := 0;
    return new;
  end if;

  if new.org_id is distinct from old.org_id or new.id is distinct from old.id
     or new.guest_token_hash is distinct from old.guest_token_hash then
    raise exception 'immutable_column' using errcode = '42501';
  end if;

  -- Undo is validated by api.undo_event (V3), which restores the previous status.
  if act = 'undo' then
    new.version := old.version + 1;
    return new;
  end if;

  if act is not null and act <> 'transfer' then
    select t.to_status into target
    from app.visit_transitions t
    where t.from_status = old.status and t.action::text = act;
    if target is null or target <> new.status then
      raise exception 'illegal_transition'
        using detail = format('%s -> %s via %s', old.status, new.status, act);
    end if;
  elsif new.status is distinct from old.status then
    raise exception 'illegal_transition'
      using detail = format('%s -> %s without an action', old.status, new.status);
  end if;

  new.version := old.version + 1;
  return new;
end $$;

create or replace function private.write_visit_event() returns trigger
language plpgsql set search_path = '' as $$
declare
  kind app.actor_kind := current_setting('app.actor_kind')::app.actor_kind;
  actor uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
  payload jsonb := coalesce(nullif(current_setting('app.event_payload', true), ''), '{}')::jsonb;
  grant_id uuid;
begin
  -- A staff RPC run by a non-member came through a support grant: record who and which grant.
  if kind = 'staff' and actor is not null and not exists (
    select 1 from app.memberships m where m.org_id = new.org_id and m.user_id = actor
  ) then
    grant_id := (private.support_grant(new.org_id)).id;
    if grant_id is not null then
      kind := 'platform';
      payload := payload || jsonb_build_object('support_grant_id', grant_id);
    end if;
  end if;

  insert into app.visit_events (org_id, visit_id, type, from_status, to_status,
                                actor_kind, actor_id, reason, payload)
  values (
    new.org_id,
    new.id,
    case when tg_op = 'INSERT' then 'joined' else coalesce(private.current_action(), 'updated') end,
    case when tg_op = 'INSERT' then null else old.status end,
    new.status,
    kind,
    actor,
    nullif(current_setting('app.reason', true), ''),
    payload
  );
  return null;
end $$;

create or replace function private.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec jsonb := to_jsonb(coalesce(new, old));
  org uuid := coalesce((rec ->> 'org_id')::uuid, case when tg_table_name = 'organizations' then (rec ->> 'id')::uuid end);
  uid uuid := (select auth.uid());
  member_role text;
  grant_id uuid;
begin
  -- System rows (org_id null) belong to no tenant, and rows removed by an org cascade have
  -- nowhere to be logged.
  if org is null or (tg_op = 'DELETE' and not exists (select 1 from app.organizations where id = org)) then
    return null;
  end if;
  select m.role::text into member_role from app.memberships m where m.user_id = uid and m.org_id = org;
  if member_role is null and uid is not null then
    grant_id := (private.support_grant(org)).id;
  end if;
  insert into app.audit_log (org_id, actor, role, action, table_name, row_id, before, after, support_grant_id)
  values (
    org,
    uid,
    coalesce(member_role,
             case when grant_id is not null then 'platform' end,
             nullif(current_setting('request.jwt.claim.role', true), ''),
             'system'),
    tg_op,
    tg_table_name,
    coalesce(rec ->> 'id', rec ->> 'old_slug', rec ->> 'user_id'),
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end,
    grant_id
  );
  return null;
end $$;
comment on function private.audit_row() is
  'AFTER trigger on config tables: records actor, role, before and after for every change. A '
  'change made through a support grant has role ''platform'' and the grant id.';

create or replace function api.set_queue_state(p_queue_id uuid, p_state api.queue_state)
returns api.queue_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  q app.queues;
  blocked text;
begin
  select * into q from app.queues where id = p_queue_id and archived_at is null;
  if not found or not private.has_role(q.org_id, q.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  blocked := private.write_blocked_reason(q.org_id, 'staff', (select auth.uid()));
  if blocked is not null then
    raise exception '%', blocked using errcode = '42501';
  end if;
  if p_state is null then
    raise exception 'invalid_input';
  end if;

  -- Waits for in-flight joins (they hold the queue FOR SHARE), so none lands after the change.
  update app.queues set manual_state = p_state
  where id = q.id and manual_state <> p_state;
  if found then
    perform private.bump_queue_version(q.id);
  end if;

  return private.queue_row(q.id);
end $$;
comment on function api.set_queue_state(uuid, api.queue_state) is
  'Opens, pauses or closes a queue for every entry point at once and returns it; staff or above '
  'of the queue''s location, or support with an ''act'' grant. Pausing and closing both stop new '
  'joins and keep waiting guests in line. A change is audited and bumps the queue version; '
  'setting the current state again changes nothing. Raises not_found for a queue outside the '
  'caller''s locations, org_suspended (42501) when the org is not active, permission_denied '
  '(42501) for a read-only support grant, invalid_input for a null state. Implemented in V4 (#33).';

------------------------------------------------------------------------------------------------
-- RPCs
------------------------------------------------------------------------------------------------

create function api.grant_support_access(p_org_id uuid, p_scope text, p_hours int, p_reason text)
returns app.support_grants
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  result app.support_grants;
begin
  if not private.has_role(p_org_id, null, 'owner') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_scope is null or p_scope not in ('read', 'act') or p_hours is null or p_hours not between 1 and 72
     or length(btrim(coalesce(p_reason, ''))) not between 1 and 500 then
    raise exception 'invalid_input';
  end if;

  update app.support_grants set revoked_at = now(), revoked_by = uid
  where org_id = p_org_id and not break_glass and revoked_at is null;

  insert into app.support_grants (org_id, granted_by, scope, reason, expires_at)
  values (p_org_id, uid, p_scope::app.support_scope, btrim(p_reason), now() + make_interval(hours => p_hours))
  returning * into result;
  return result;
end $$;
comment on function api.grant_support_access(uuid, text, int, text) is
  'Owner only: gives the platform''s support staff ''read'' (staff-level reads, no writes) or '
  '''act'' (up to admin, never owner) access to the org for p_hours (1-72) and returns the grant. '
  'A second live grant replaces the first; break-glass grants are untouched. Support act as '
  'themselves and every change they make is attributed to them. Raises permission_denied (42501) '
  'for anyone but an owner, invalid_input for a bad scope, hours or blank reason.';

create function api.revoke_support_access(p_org_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not private.has_role(p_org_id, null, 'owner') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  update app.support_grants set revoked_at = now(), revoked_by = (select auth.uid())
  where org_id = p_org_id and revoked_at is null and expires_at > now();
end $$;
comment on function api.revoke_support_access(uuid) is
  'Owner only: ends every live support grant for the org at once, break-glass included. '
  'Idempotent: with no live grant it does nothing. Raises permission_denied (42501) for anyone '
  'but an owner.';

create function api.platform_break_glass(p_org_id uuid, p_reason text) returns app.support_grants
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  result app.support_grants;
begin
  perform private.require_platform('operator');
  if length(btrim(coalesce(p_reason, ''))) not between 1 and 500 then
    raise exception 'invalid_input';
  end if;
  if not exists (select 1 from app.organizations where id = p_org_id) then
    raise exception 'not_found';
  end if;

  select * into result from app.support_grants
  where org_id = p_org_id and break_glass and grantee = uid and revoked_at is null and expires_at > now();
  if found then
    return result;
  end if;

  insert into app.support_grants (org_id, granted_by, grantee, scope, reason, break_glass, expires_at)
  values (p_org_id, uid, uid, 'read', btrim(p_reason), true, now() + interval '1 hour')
  returning * into result;
  perform private.platform_audit('support.break_glass', p_org_id,
                                 jsonb_build_object('support_grant_id', result.id), result.reason);
  return result;
end $$;
comment on function api.platform_break_glass(uuid, text) is
  'Operator only (aal2): opens one hour of read-only access to the org for the caller, with a '
  'required reason, and returns the grant. Recorded in platform_audit and in the org''s own '
  'audit_log, and visible to the owner, who can end it with revoke_support_access; the operator '
  'cannot revoke or hide it. Calling again while it is live returns the same grant. Raises '
  'permission_denied (42501) without operator and aal2, invalid_input for a blank reason, '
  'not_found for an unknown org.';

------------------------------------------------------------------------------------------------
-- Device pairing and undo (bodies from 20261025001100 / 001500, one change each)
------------------------------------------------------------------------------------------------

create or replace function api.create_pairing_code(p_location_id uuid, p_kind app.device_kind, p_name text)
returns api.pairing_code
language plpgsql volatile security definer set search_path = '' as $$
declare
  loc app.locations;
  result api.pairing_code;
  h bytea;
begin
  select * into loc from app.locations where id = p_location_id;
  if not found or not private.has_role(loc.org_id, loc.id, 'admin') then
    raise exception 'not_found';
  end if;
  -- A paired device outlives any support grant, so support never pairs one.
  if not exists (select 1 from app.memberships m where m.org_id = loc.org_id and m.user_id = (select auth.uid())) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_kind is null or length(coalesce(p_name, '')) > 80 then
    raise exception 'invalid_input';
  end if;
  -- Live codes share one 6-digit space across tenants; a cap per org keeps a guess unlikely.
  if (select count(*) from app.device_pairing_codes
      where org_id = loc.org_id and used_at is null and expires_at > now()) >= 10 then
    raise exception 'rate_limited';
  end if;

  result.expires_at := now() + interval '10 minutes';
  loop
    result.code := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint
                          % 1000000)::text), 6, '0');
    h := extensions.digest(result.code, 'sha256');
    -- An expired, unused code with the same digits must not block the new one.
    delete from app.device_pairing_codes
    where code_hash = h and used_at is null and expires_at <= now();
    begin
      insert into app.device_pairing_codes (org_id, location_id, kind, name, code_hash, expires_at,
                                            created_by)
      values (loc.org_id, loc.id, p_kind, btrim(coalesce(p_name, '')), h, result.expires_at,
              (select auth.uid()));
      exit;
    exception when unique_violation then
      null; -- another live code has these digits; draw again
    end;
  end loop;

  return result;
end $$;
comment on function api.create_pairing_code(uuid, app.device_kind, text) is
  'Creates a single-use 6-digit code that pairs one display or kiosk to the location, valid for '
  '10 minutes, and returns it with its expiry. The code itself is never stored, so it cannot be '
  'shown again; create a new one instead. Admins of the location only, never support through a '
  'grant (a device outlives the grant). Raises not_found for a location the caller does not '
  'administer, permission_denied (42501) for a support grantee, invalid_input for a missing kind or a name over 80 '
  'characters, rate_limited when the org already has 10 live codes.';


create or replace function api.undo_event(p_event_id bigint, p_idempotency_key uuid) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  e app.visit_events;
  v app.visits;
  prior app.visits;
  claim record;
  result api.visit_row;
begin
  select * into e from app.visit_events where id = p_event_id;
  if found then
    select * into v from app.visits where id = e.visit_id;
  end if;
  if v.id is null or not private.has_role(v.org_id, v.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_idempotency_key is null then
    raise exception 'invalid_input';
  end if;

  select * into claim from private.claim_idempotent(v.org_id, 'undo_event', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  -- Lock the visit, then re-read the event: an undo or action that committed meanwhile shows.
  select * into v from app.visits where id = e.visit_id for update;
  select * into e from app.visit_events where id = p_event_id;
  -- Reversible: a staff action (or support's, through a grant) (not joins, undos, edits or system expiry) that is still the
  -- visit's latest event and under 10 minutes old.
  if e.actor_kind not in ('staff', 'platform')
     or e.type not in ('call', 'recall', 'start', 'requeue', 'complete', 'no_show', 'cancel',
                       'remove', 'reinstate', 'check_in')
     or e.undone_by_event_id is not null
     or e.occurred_at < now() - interval '10 minutes'
     or e.id <> (select max(x.id) from app.visit_events x where x.visit_id = v.id) then
    raise exception 'undo_not_allowed';
  end if;

  prior := private.undo_target(v, e);
  perform private.set_actor('staff', (select auth.uid()), 'undo', null,
                            jsonb_build_object('undoes_event_id', e.id, 'undoes_type', e.type));
  update app.visits
  set status = prior.status,
      counter_id = prior.counter_id,
      call_count = prior.call_count,
      called_at = prior.called_at,
      serving_at = prior.serving_at,
      assigned_staff_id = prior.assigned_staff_id,
      finished_at = prior.finished_at
  where id = v.id;
  perform private.bump_queue_version(v.queue_id);

  result := private.visit_row(v.id);
  update app.visit_events set undone_by_event_id = result.last_event_id where id = e.id;
  perform private.save_idempotent('undo_event', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.undo_event(bigint, uuid) is
  'Reverses a staff action on a visit (call, recall, start, requeue, complete, no_show, cancel, '
  'remove, reinstate, check_in) by writing a compensating ''undo'' event and restoring the '
  'previous status, counter, call count and timestamps; the place in line is unchanged, so a '
  'visit called by mistake is waiting where it was. The original event gets undone_by_event_id. '
  'Returns the updated row. Repeating a key returns the first result. Raises not_found for an '
  'event outside the caller''s locations (staff or above; no existence leak), invalid_input '
  'without a key, undo_not_allowed when the event is not the visit''s latest (anything changed '
  'since, including an earlier undo), is older than 10 minutes, or is not a staff action '
  '(support actions through a grant count as staff actions). '
  'Implemented in V3 (#32).';


revoke all on function private.support_grant(uuid) from public, anon, authenticated;
revoke all on function private.write_blocked_reason(uuid, text, uuid) from public, anon, authenticated;
revoke all on function api.grant_support_access(uuid, text, int, text) from public, anon;
revoke all on function api.revoke_support_access(uuid) from public, anon;
revoke all on function api.platform_break_glass(uuid, text) from public, anon;
grant execute on function api.grant_support_access(uuid, text, int, text) to authenticated;
grant execute on function api.revoke_support_access(uuid) to authenticated;
grant execute on function api.platform_break_glass(uuid, text) to authenticated;

------------------------------------------------------------------------------------------------
-- Privileges and row-level security
------------------------------------------------------------------------------------------------

-- Written only by the RPCs above. Members read them so staff can see "support has access".
revoke insert, update, delete, truncate on app.support_grants from authenticated;
alter table app.support_grants enable row level security;
create policy support_grants_select on app.support_grants for select to authenticated
  using ((select private.has_role(org_id, null, 'staff')));
