-- 2A-TM2 (#96): role changes, offboarding and the member list. Replaces the bodies of
-- api.set_member_role and api.remove_member (signatures from 20261030045508_api_contracts_2a.sql
-- are unchanged) and adds api.list_members, which the team page (2A-TM3) needs because member
-- emails live in auth.users and RLS cannot expose them.
--
-- Access is cut at once because every RPC and RLS check reads app.memberships (private.has_role);
-- an access token already issued stays valid until it expires, which docs/ops/offboarding.md
-- covers. Sessions and refresh tokens are deleted so the user cannot get a new one.

alter table app.memberships add column removal_reason text check (length(removal_reason) <= 500);

/** Whether every id is a location of the org; null (all locations) is valid, an empty array is not. */
create function private.valid_location_ids(p_org_id uuid, p_ids uuid[]) returns boolean
language sql stable set search_path = '' as $$
  select p_ids is null or (cardinality(p_ids) > 0 and not exists (
    select 1 from unnest(p_ids) l
    where not exists (select 1 from app.locations x where x.id = l and x.org_id = p_org_id)))
$$;
revoke all on function private.valid_location_ids(uuid, uuid[]) from public, anon, authenticated;

/** Whether the signed-in actor's own location scope covers p_target (null = every location). */
create function private.actor_covers(p_org_id uuid, p_target uuid[]) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(a.location_ids is null or (p_target is not null and p_target <@ a.location_ids), false)
  from app.memberships a where a.org_id = p_org_id and a.user_id = (select auth.uid())
$$;
comment on function private.actor_covers(uuid, uuid[]) is
  'True when the caller is not location-scoped, or p_target is a non-null set within their locations. '
  'A scoped admin cannot manage or grant wider access than they hold.';
revoke all on function private.actor_covers(uuid, uuid[]) from public, anon, authenticated;

/**
 * Deletes the removed user's Auth sessions and refresh tokens, so no new access token can be
 * minted. Runs for every deletion of a membership, not only through remove_member.
 */
create function private.revoke_member_sessions() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- An organization being deleted removes its memberships; members elsewhere keep their sessions.
  if not exists (select 1 from app.organizations o where o.id = old.org_id) then
    return null;
  end if;
  delete from auth.refresh_tokens where user_id = old.user_id::text;
  delete from auth.sessions where user_id = old.user_id;
  return null;
end $$;
comment on function private.revoke_member_sessions() is
  'AFTER DELETE on app.memberships: ends every Auth session of the removed user (all devices, and '
  'their other organizations too, so they sign in again) and deletes their refresh tokens.';
revoke all on function private.revoke_member_sessions() from public, anon, authenticated;
create trigger revoke_sessions after delete on app.memberships
  for each row execute function private.revoke_member_sessions();

-- redefines api.set_member_role from 20261030045508_api_contracts_2a.sql
create or replace function api.set_member_role(p_membership_id uuid, p_role text, p_location_ids uuid[], p_idempotency_key uuid)
returns api.membership_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  m app.memberships;
  v_role app.member_role;
  actor app.member_role;
  claim record;
begin
  select * into m from app.memberships where id = p_membership_id for update;
  if not found then raise exception 'not_found'; end if;
  actor := private.require_people_manager(m.org_id, 'staff');
  begin
    v_role := p_role::app.member_role;
  exception when others then
    raise exception 'invalid_input';
  end;
  if p_idempotency_key is null or not private.valid_location_ids(m.org_id, p_location_ids) then
    raise exception 'invalid_input';
  end if;
  -- Serialises concurrent demotions, so two owners cannot demote each other to zero owners.
  if m.role = 'owner' then
    perform 1 from app.memberships o where o.org_id = m.org_id and o.role = 'owner' for update;
    if v_role <> 'owner' and not exists (
         select 1 from app.memberships o where o.org_id = m.org_id and o.role = 'owner' and o.id <> m.id) then
      raise exception 'last_owner';
    end if;
  end if;
  if m.user_id = (select auth.uid()) or not private.can_manage_role(actor, m.role)
     or not private.can_manage_role(actor, v_role)
     or not private.actor_covers(m.org_id, m.location_ids) or not private.actor_covers(m.org_id, p_location_ids) then
    raise exception 'forbidden_role';
  end if;

  select * into claim from private.claim_idempotent(m.org_id, 'set_member_role', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.membership_row, claim.response);
  end if;
  update app.memberships set role = v_role, location_ids = p_location_ids
  where id = m.id returning * into m;
  perform private.save_idempotent('set_member_role', p_idempotency_key, to_jsonb(private.membership_row(m)));
  return private.membership_row(m);
end $$;
comment on function api.set_member_role(uuid, text, uuid[], uuid) is
  'Changes a member''s role and locations (null locations = all). Owners any role, admins manager '
  'and staff only; nobody changes their own role; the last owner cannot be demoted. The change is '
  'recorded in the audit log with actor, before and after. Raises not_found (unknown or foreign '
  'id), permission_denied, forbidden_role, last_owner, invalid_input, org_suspended. Idempotent '
  'per key. Implemented by 2A-TM2.';

-- redefines api.remove_member from 20261030045508_api_contracts_2a.sql
create or replace function api.remove_member(p_membership_id uuid, p_reason text, p_idempotency_key uuid)
returns api.membership_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  m app.memberships;
  actor app.member_role;
  claim record;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  removed api.membership_row;
  visit record;
begin
  select * into m from app.memberships where id = p_membership_id for update;
  if not found then
    -- A repeat of a call that already removed the member answers the same way.
    select r.* into removed
    from app.idempotency_keys k, lateral jsonb_populate_record(null::api.membership_row, k.response) r
    where k.actor_id = (select auth.uid()) and k.rpc = 'remove_member' and k.key = p_idempotency_key
      and k.response is not null;
    if removed.id is null then raise exception 'not_found'; end if;
    return removed;
  end if;
  actor := private.require_people_manager(m.org_id, 'staff');
  if p_idempotency_key is null or length(coalesce(v_reason, '')) > 500 then
    raise exception 'invalid_input';
  end if;
  if m.role = 'owner' then
    perform 1 from app.memberships o where o.org_id = m.org_id and o.role = 'owner' for update;
    if not exists (select 1 from app.memberships o where o.org_id = m.org_id and o.role = 'owner' and o.id <> m.id) then
      raise exception 'last_owner';
    end if;
  end if;
  if m.user_id = (select auth.uid()) or not private.can_manage_role(actor, m.role)
     or not private.actor_covers(m.org_id, m.location_ids) then
    raise exception 'forbidden_role';
  end if;

  select * into claim from private.claim_idempotent(m.org_id, 'remove_member', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.membership_row, claim.response);
  end if;

  -- Their waiting guests go back to the pool, each with an event naming who removed them.
  perform private.set_actor('staff', (select auth.uid()), 'unassigned', v_reason,
                            jsonb_build_object('previous_staff_id', m.user_id));
  for visit in
    select v.id, v.queue_id from app.visits v
    where v.org_id = m.org_id and v.assigned_staff_id = m.user_id and v.status = 'waiting'
  loop
    update app.visits set assigned_staff_id = null where id = visit.id;
    perform private.bump_queue_version(visit.queue_id);
  end loop;

  -- The reason rides along in the before-row of the audit record for the delete.
  update app.memberships set removal_reason = v_reason where id = m.id;
  delete from app.memberships where id = m.id;

  removed := private.membership_row(m);
  removed.removed_at := now();
  perform private.save_idempotent('remove_member', p_idempotency_key, to_jsonb(removed));
  return removed;
end $$;
comment on function api.remove_member(uuid, text, uuid) is
  'Removes a member at once: deletes the membership (the audit log keeps the before-row and the '
  'reason), their Auth sessions and refresh tokens, and unassigns their waiting visits with an '
  '''unassigned'' event. Owners any role, admins manager and staff; nobody removes themselves; the '
  'last owner cannot be removed. Raises not_found, permission_denied, forbidden_role, last_owner, '
  'invalid_input, org_suspended. Idempotent per key. Implemented by 2A-TM2.';

-- Why a new entry point (CLAUDE.md interface rule 1): member emails are in auth.users, so no table
-- read can give the team page a name, email and role together.
create function api.list_members(p_org_id uuid) returns setof api.membership_row
language plpgsql stable security definer set search_path = '' as $$
declare actor app.member_role := private.caller_role(p_org_id);
begin
  if actor is null then raise exception 'not_found'; end if;
  return query
    select r.id, r.org_id, r.user_id,
           case when actor >= 'admin' then r.email end,
           r.display_name, r.role, r.location_ids, r.has_pin, r.created_at, r.removed_at
    from app.memberships m, lateral private.membership_row(m) r
    where m.org_id = p_org_id
    order by m.role desc, m.created_at;
end $$;
comment on function api.list_members(uuid) is
  'The org''s members with name, role and locations. Any member may list; emails are shown only to '
  'owners and admins. Raises not_found for a non-member. Implemented by 2A-TM2.';
revoke all on function api.list_members(uuid) from public, anon;
grant execute on function api.list_members(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
