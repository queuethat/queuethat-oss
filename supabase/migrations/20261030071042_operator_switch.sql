-- 2A-TM4 (#98): PIN-based operator switch for shared tablets. Replaces the bodies of
-- api.set_my_pin, switch_operator and end_operator_session (signatures from
-- 20261030045508_api_contracts_2a.sql are unchanged).
--
-- The tablet stays signed in as a member. switch_operator hands back a random token (stored as
-- sha256); the web app sends it as the x-operator-token request header, which PostgREST exposes as
-- request.headers. While a valid token is present the operator is the actor: private.has_role
-- checks their membership and role instead of the tablet account's, visit events and assignments
-- name them, and team management (invitations, roles, removal) is refused because it needs the
-- person's own login. A token that is unknown, expired, ended or from another session raises
-- operator_session_invalid; it never silently falls back to the tablet account. That includes
-- table reads, so the client drops the header on that error and asks "who is working?" again.

alter table app.memberships add column pin_hash text;
-- The hash is never readable or writable through the API, not even by owners: a 4-8 digit PIN
-- falls to an offline guess in seconds. Only the definer RPCs below touch it.
revoke select, insert, update on app.memberships from authenticated;
grant select (id, org_id, user_id, role, location_ids, created_at, display_name, removal_reason)
  on app.memberships to authenticated;
grant insert (org_id, user_id, role, location_ids, display_name) on app.memberships to authenticated;
grant update (role, location_ids, display_name) on app.memberships to authenticated;

create table app.operator_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  -- The signed-in tablet account, and the member who is working on it.
  device_user_id uuid not null references auth.users (id) on delete cascade,
  operator_user_id uuid not null references auth.users (id) on delete cascade,
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '8 hours',
  ended_at timestamptz,
  foreign key (org_id, location_id) references app.locations (org_id, id) on delete cascade
);
create index operator_sessions_device_idx on app.operator_sessions (device_user_id, location_id) where ended_at is null;
create trigger forbid_org_change before update on app.operator_sessions
  for each row execute function private.forbid_org_change();

-- Written only by the RPCs below; the token hash is never readable.
revoke all on app.operator_sessions from authenticated;
grant select (id, org_id, location_id, device_user_id, operator_user_id, created_at, expires_at, ended_at)
  on app.operator_sessions to authenticated;
alter table app.operator_sessions enable row level security;
create policy operator_sessions_select on app.operator_sessions for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')));

-- Failed PIN attempts per location and member. Not exposed (private schema).
create table private.pin_attempts (
  location_id uuid not null,
  user_id uuid not null,
  failures int not null default 0,
  last_failed_at timestamptz,
  locked_until timestamptz,
  primary key (location_id, user_id)
);

------------------------------------------------------------------------------------------------
-- Who is acting
------------------------------------------------------------------------------------------------

/**
 * The live operator session named by the x-operator-token header for the signed-in tablet account,
 * an all-null row when there is no header. Raises operator_session_invalid for any token that is
 * not a current session of this account.
 */
create function private.operator_session() returns app.operator_sessions
language plpgsql stable set search_path = '' as $$
declare
  headers json;
  token text;
  os app.operator_sessions;
begin
  begin
    headers := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json;
  exception when others then
    headers := '{}'::json;
  end;
  token := nullif(headers ->> 'x-operator-token', '');
  if token is null then
    return os;
  end if;
  select * into os from app.operator_sessions s
  where s.token_hash = private.token_hash(token) and s.device_user_id is not distinct from (select auth.uid())
    and s.ended_at is null and s.expires_at > now();
  if not found then
    raise exception 'operator_session_invalid';
  end if;
  return os;
end $$;
comment on function private.operator_session() is
  'The caller''s live operator session from the x-operator-token header, an all-null row without '
  'the header; raises operator_session_invalid for an unknown, ended, expired or foreign token.';
revoke all on function private.operator_session() from public, anon, authenticated;

/** The member acting now: the operator while a token is present, otherwise the signed-in user. */
create function private.actor_id() returns uuid
language sql stable set search_path = '' as $$
  select coalesce((private.operator_session()).operator_user_id, (select auth.uid()))
$$;
revoke all on function private.actor_id() from public, anon, authenticated;

/** p_user when it is someone else; the acting operator when p_user is the signed-in tablet account. */
create function private.effective_user(p_user uuid) returns uuid
language sql stable set search_path = '' as $$
  select case when p_user is not distinct from (select auth.uid()) then private.actor_id() else p_user end
$$;
revoke all on function private.effective_user(uuid) from public, anon, authenticated;

-- redefines private.has_role from 20261030063304_mfa_enforcement.sql
create or replace function private.has_role(p_org_id uuid, p_location_id uuid, p_min_role app.member_role)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare os app.operator_sessions := private.operator_session();
begin
  -- An operator's authority is their own, and only at the session's location.
  if os.id is not null and (os.org_id <> p_org_id or (p_location_id is not null and p_location_id <> os.location_id)) then
    return false;
  end if;
  return exists (
    select 1
    from app.memberships m
    join app.organizations o on o.id = m.org_id
    where m.user_id = coalesce(os.operator_user_id, (select auth.uid()))
      and m.org_id = p_org_id
      and (case
             -- A PIN is not a second factor: an operator never exceeds manager, whatever the tablet's session.
             when m.role > 'manager' and os.id is not null then 'manager'::app.member_role
             when o.require_mfa_for_admins and m.role > 'manager'
                  and coalesce((select auth.jwt()) ->> 'aal', '') <> 'aal2' then 'manager'::app.member_role
             else m.role
           end) >= p_min_role
      and (m.location_ids is null or p_location_id is null or p_location_id = any (m.location_ids))
      and (o.status = 'active' or p_min_role = 'staff')
  ) or (os.id is null and exists (
    select 1
    from private.support_grant(p_org_id) g
    join app.organizations o on o.id = g.org_id
    where g.id is not null
      and case g.scope when 'act' then p_min_role <= 'admin' else p_min_role = 'staff' end
      and (o.status = 'active' or p_min_role = 'staff')
  ));
end $$;
comment on function private.has_role(uuid, uuid, app.member_role) is
  'True when the caller is a member of the org with at least p_min_role. With a location, the '
  'membership must cover it (location_ids null = all). With p_location_id null, any membership '
  'in the org counts. A platform user with a live support grant (private.support_grant) passes '
  'staff-level checks with ''read'' and checks up to admin with ''act'', at every location; '
  'never owner. When the org is not active (suspended or pending_deletion), only staff-level '
  'checks pass; every manager-level or higher check fails. When the org requires MFA '
  '(require_mfa_for_admins), an owner or admin whose session is not aal2 counts as a manager. '
  'While an operator token is present the operator''s membership is checked instead of the '
  'caller''s, capped at manager, for that session''s location only; an invalid token raises operator_session_invalid. '
  'Staff-level checks also admit reads, so writes behind them are refused by '
  'private.write_blocked_reason. The only role check policies and api functions use.';

-- redefines private.set_actor from 20261025000400_visits.sql
create or replace function private.set_actor(
  p_kind app.actor_kind,
  p_actor_id uuid,
  p_action text default null,
  p_reason text default null,
  p_payload jsonb default '{}'
) returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_actor uuid := p_actor_id;
  v_payload jsonb := coalesce(p_payload, '{}');
begin
  -- A staff event made by the signed-in tablet account is the operator's while one is working.
  if p_kind = 'staff' and p_actor_id is not distinct from (select auth.uid()) then
    v_actor := private.actor_id();
    if v_actor is distinct from p_actor_id then
      v_payload := v_payload || jsonb_build_object('device_user_id', p_actor_id);
    end if;
  end if;
  perform set_config('app.actor_kind', p_kind::text, true),
          set_config('app.actor_id', coalesce(v_actor::text, ''), true),
          set_config('app.action', coalesce(p_action, ''), true),
          set_config('app.reason', coalesce(p_reason, ''), true),
          set_config('app.event_payload', v_payload::text, true);
end $$;
comment on function private.set_actor(app.actor_kind, uuid, text, text, jsonb) is
  'Sets transaction-local actor context read by the visit triggers: actor kind and id, the '
  'action being applied (a visit_action name, ''undo'', or null for non-status edits), an '
  'optional reason and event payload. Call again before each distinct change. A staff actor equal '
  'to the signed-in account is replaced by the working operator (x-operator-token), and the '
  'account is recorded as device_user_id in the payload.';
revoke all on function private.set_actor(app.actor_kind, uuid, text, text, jsonb) from public, anon, authenticated;

-- redefines private.visit_eligible from 20261030063127_call_next_resources.sql
create or replace function private.visit_eligible(
  p_service_id uuid,
  p_assigned_counter_id uuid,
  p_assigned_staff_id uuid,
  p_counter_id uuid,
  p_actor uuid
) returns boolean
language sql stable set search_path = '' as $$
  select
    -- Assignment: unassigned, or assigned to this counter, or assigned to this person.
    ((p_assigned_counter_id is null and p_assigned_staff_id is null)
      or p_assigned_counter_id = p_counter_id
      or p_assigned_staff_id = private.effective_user(p_actor))
    -- Mapping: a service with no mapped resources is served by anyone.
    and (p_service_id is null
      or not exists (select 1 from app.service_resources sr where sr.service_id = p_service_id)
      or exists (
        select 1
        from app.service_resources sr
        join app.counters c on c.id = sr.counter_id and c.active and c.archived_at is null
        where sr.service_id = p_service_id
          and (sr.counter_id = p_counter_id
               or (c.kind = 'staff' and c.member_user_id = private.effective_user(p_actor)))))
$$;
comment on function private.visit_eligible(uuid, uuid, uuid, uuid, uuid) is
  'Whether a waiting visit may be offered to p_actor serving at p_counter_id: it is unassigned or '
  'assigned to that counter or person, and its service has no mapped resources or p_counter_id (or '
  'a staff resource of p_actor) is one of them. p_actor is the person acting, so the signed-in '
  'tablet account stands for the working operator. The single owner of this rule; call_next '
  'filters with it and transition_visit uses it to flag overrides.';

-- A visit assigned to the signed-in tablet account is assigned to the working operator.
create function private.attribute_operator() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.assigned_staff_id is distinct from old.assigned_staff_id
     and new.assigned_staff_id is not distinct from (select auth.uid()) then
    new.assigned_staff_id := private.actor_id();
  end if;
  return new;
end $$;
revoke all on function private.attribute_operator() from public, anon, authenticated;
create trigger attribute_operator before update on app.visits
  for each row execute function private.attribute_operator();

-- redefines private.caller_role from 20261030061824_invitations.sql
create or replace function private.caller_role(p_org_id uuid) returns app.member_role
language plpgsql stable set search_path = '' as $$
declare os app.operator_sessions := private.operator_session();
begin
  if os.id is not null and os.org_id <> p_org_id then return null; end if;
  return (select m.role from app.memberships m
          where m.org_id = p_org_id and m.user_id = coalesce(os.operator_user_id, (select auth.uid())));
end $$;
comment on function private.caller_role(uuid) is
  'The acting member''s role in the org (the working operator while a token is present), or null '
  'for a non-member. The one place team-management RPCs read the acting role.';

-- redefines private.require_people_manager from 20261030061824_invitations.sql
create or replace function private.require_people_manager(p_org_id uuid, p_target app.member_role)
returns app.member_role
language plpgsql stable set search_path = '' as $$
declare actor app.member_role := private.caller_role(p_org_id);
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if actor is null then raise exception 'not_found'; end if;
  -- Managing people needs the person's own login, not a PIN on a shared tablet.
  if (private.operator_session()).id is not null then raise exception 'permission_denied' using errcode = '42501'; end if;
  if actor < 'admin' then raise exception 'permission_denied' using errcode = '42501'; end if;
  if not private.can_manage_role(actor, p_target) then raise exception 'forbidden_role'; end if;
  if exists (select 1 from app.organizations o where o.id = p_org_id and o.status <> 'active') then
    raise exception 'org_suspended';
  end if;
  return actor;
end $$;

-- redefines private.membership_row from 20261030061824_invitations.sql
create or replace function private.membership_row(p_membership app.memberships) returns api.membership_row
language sql stable set search_path = '' as $$
  select p_membership.id, p_membership.org_id, p_membership.user_id,
         (select u.email::text from auth.users u where u.id = p_membership.user_id),
         p_membership.display_name, p_membership.role::text, p_membership.location_ids,
         p_membership.pin_hash is not null, p_membership.created_at, null::timestamptz
$$;

-- redefines private.revoke_member_sessions from 20261030064302_member_management.sql
create or replace function private.revoke_member_sessions() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- An organization being deleted removes its memberships; members elsewhere keep their sessions.
  if not exists (select 1 from app.organizations o where o.id = old.org_id) then
    return null;
  end if;
  update app.operator_sessions set ended_at = now()
  where org_id = old.org_id and ended_at is null and old.user_id in (operator_user_id, device_user_id);
  delete from auth.refresh_tokens where user_id = old.user_id::text;
  delete from auth.sessions where user_id = old.user_id;
  return null;
end $$;
comment on function private.revoke_member_sessions() is
  'AFTER DELETE on app.memberships: ends every Auth session of the removed user (all devices, and '
  'their other organizations too, so they sign in again), deletes their refresh tokens and ends '
  'the operator sessions they worked or whose tablet account they were.';

------------------------------------------------------------------------------------------------
-- RPCs
------------------------------------------------------------------------------------------------

-- redefines api.set_my_pin from 20261030045508_api_contracts_2a.sql
create or replace function api.set_my_pin(p_org_id uuid, p_pin text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  -- Changing a PIN needs the person's own login: a stolen operator token must not become the PIN.
  if (private.operator_session()).id is not null then raise exception 'permission_denied' using errcode = '42501'; end if;
  if not exists (select 1 from app.memberships m where m.org_id = p_org_id and m.user_id = uid) then
    raise exception 'not_a_member';
  end if;
  -- 4 to 8 digits, not one repeated digit (0000) and not a run (1234, 4321).
  if p_pin is null or p_pin !~ '^[0-9]{4,8}$' or p_pin ~ '^([0-9])\1+$'
     or position(p_pin in '01234567890123456789') > 0 or position(p_pin in '98765432109876543210') > 0 then
    raise exception 'invalid_input';
  end if;
  update app.memberships set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf'))
  where org_id = p_org_id and user_id = uid;
  delete from private.pin_attempts where user_id = uid;
end $$;
comment on function api.set_my_pin(uuid, text) is
  'Sets or replaces the signed-in member''s operator PIN for the org (stored as a bcrypt hash). '
  'Refused under an operator token (permission_denied). Raises invalid_input for a PIN '
  'that is not 4 to 8 digits, all one digit or a run like 1234 or 4321, and not_a_member. Never '
  'returns the PIN. Implemented by 2A-TM4.';

-- redefines api.switch_operator from 20261030045508_api_contracts_2a.sql
create or replace function api.switch_operator(p_location_id uuid, p_user_id uuid, p_pin text)
returns api.operator_session
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid;
  tablet app.memberships;
  target app.memberships;
  att private.pin_attempts;
  matched boolean := false;
  token text;
  result api.operator_session;
  expires timestamptz;
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  select l.org_id into v_org from app.locations l where l.id = p_location_id;
  -- The signed-in account itself (never an operator) must work at this location.
  select * into tablet from app.memberships m
  where m.org_id = v_org and m.user_id = (select auth.uid())
    and (m.location_ids is null or p_location_id = any (m.location_ids));
  if v_org is null or not found then raise exception 'not_found'; end if;
  if exists (select 1 from app.organizations o where o.id = v_org and o.status <> 'active') then
    raise exception 'org_suspended';
  end if;

  select * into target from app.memberships m
  where m.org_id = v_org and m.user_id = p_user_id and m.pin_hash is not null
    and (m.location_ids is null or p_location_id = any (m.location_ids));
  if found then
    insert into private.pin_attempts (location_id, user_id) values (p_location_id, p_user_id)
    on conflict do nothing;
    select * into att from private.pin_attempts a where a.location_id = p_location_id and a.user_id = p_user_id for update;
    -- Always hash, so a locked member answers as slowly as a wrong PIN.
    matched := extensions.crypt(coalesce(p_pin, ''), target.pin_hash) = target.pin_hash
               and (att.locked_until is null or att.locked_until <= now());
    if matched then
      delete from private.pin_attempts a where a.location_id = p_location_id and a.user_id = p_user_id;
    elsif att.locked_until is null or att.locked_until <= now() then
      -- Five wrong PINs lock this member at this location for five minutes.
      update private.pin_attempts a set
        failures = case when a.last_failed_at < now() - interval '15 minutes' then 1 else a.failures + 1 end,
        last_failed_at = now(),
        locked_until = case when (case when a.last_failed_at < now() - interval '15 minutes' then 1 else a.failures + 1 end) >= 5
                            then now() + interval '5 minutes' end
      where a.location_id = p_location_id and a.user_id = p_user_id;
    end if;
  else
    -- Same work and same answer for an unknown member, one without a PIN or one elsewhere.
    perform extensions.crypt(coalesce(p_pin, ''), '$2a$06$0123456789012345678901uIsb1bX5gKtiLyfaYvSb1FEBrWGvO3G');
  end if;

  if not matched then
    -- An answer, not an exception: a raise would roll back the failure count above.
    return result;
  end if;

  update app.operator_sessions set ended_at = now()
  where device_user_id = (select auth.uid()) and location_id = p_location_id and ended_at is null;
  token := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=' || chr(10), '-_');
  insert into app.operator_sessions (org_id, location_id, device_user_id, operator_user_id, token_hash)
  values (v_org, p_location_id, (select auth.uid()), p_user_id, private.token_hash(token))
  returning expires_at into expires;
  result.operator_token := token;
  result.user_id := p_user_id;
  result.display_name := target.display_name;
  result.role := target.role::text;
  result.expires_at := expires;
  return result;
end $$;
comment on function api.switch_operator(uuid, uuid, text) is
  'From a tablet signed in as a member of the location, starts an operator session for the member '
  'with this PIN and returns its token once (valid 8 hours; it replaces the tablet''s previous '
  'session). A PIN that does not match, an unknown member, one without a PIN or one locked out '
  '(5 wrong PINs lock a member at this location for 5 minutes) all return the same all-null row, '
  'so nothing is learned from the answer and the failure count survives. While the token is sent '
  'as x-operator-token, mutating RPCs attribute their events to the operator and check the '
  'operator''s role. Raises not_authenticated, not_found (the caller does not work at the '
  'location), org_suspended. Implemented by 2A-TM4.';

-- redefines api.end_operator_session from 20261030045508_api_contracts_2a.sql
create or replace function api.end_operator_session(p_operator_token text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  update app.operator_sessions set ended_at = now()
  where token_hash = private.token_hash(coalesce(p_operator_token, ''))
    and device_user_id = (select auth.uid()) and ended_at is null;
end $$;
comment on function api.end_operator_session(text) is
  'Ends the operator session for the token on this tablet account. Ending an ended, expired or '
  'unknown session changes nothing. Implemented by 2A-TM4.';

-- redefines api.set_require_mfa from 20261030063304_mfa_enforcement.sql
create or replace function api.set_require_mfa(p_org_id uuid, p_required boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_required is null then
    raise exception 'invalid_input';
  end if;
  -- Raw membership, not has_role: an owner below aal2 is capped at manager once MFA is required,
  -- and must be told to step up rather than be denied.
  if not exists (select 1 from app.memberships m where m.org_id = p_org_id and m.user_id = (select auth.uid())) then
    raise exception 'not_found';
  end if;
  -- Organisation security settings need the owner's own login, not a PIN on a shared tablet.
  if (private.operator_session()).id is not null then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if not exists (select 1 from app.memberships m
                 where m.org_id = p_org_id and m.user_id = (select auth.uid()) and m.role = 'owner') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if coalesce((select auth.jwt()) ->> 'aal', '') <> 'aal2' then
    raise exception 'mfa_required';
  end if;
  update app.organizations set require_mfa_for_admins = p_required where id = p_org_id;
end $$;
comment on function api.set_require_mfa(uuid, boolean) is
  'Owner only, and only from an aal2 session so the owner cannot lock themselves out: turns the '
  'org''s MFA requirement for owners and admins on or off. Raises not_found for a non-member, '
  'permission_denied (42501) for a member who is not the owner or while an operator token is '
  'sent, mfa_required below aal2, invalid_input for null.';

notify pgrst, 'reload schema';
