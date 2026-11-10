-- 2B-ORG1 (#265): api.set_member_locations (ORG-10). Body only; reuses the checks of
-- api.set_member_role (private.require_people_manager, can_manage_role, actor_covers) so there is
-- one rule for who may change whom. memberships carry the audit trigger, so every change is logged
-- with actor, before and after.
-- redefines api.set_member_locations from 20261030162713_api_contracts_2b.sql

create or replace function api.set_member_locations(p_membership_id uuid, p_location_ids uuid[], p_idempotency_key uuid)
returns api.membership_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  m app.memberships;
  actor app.member_role;
  claim record;
begin
  select * into m from app.memberships where id = p_membership_id for update;
  if not found then raise exception 'not_found'; end if;
  actor := private.require_people_manager(m.org_id, 'staff');
  if p_idempotency_key is null or (p_location_ids is not null and cardinality(p_location_ids) = 0) then
    raise exception 'invalid_input';
  end if;
  if not private.valid_location_ids(m.org_id, p_location_ids) then
    raise exception 'invalid_location';
  end if;
  -- Nobody restricts themselves, and a location-scoped admin cannot widen anyone beyond their own reach.
  if m.user_id = (select auth.uid()) or not private.can_manage_role(actor, m.role)
     or not private.actor_covers(m.org_id, m.location_ids) or not private.actor_covers(m.org_id, p_location_ids) then
    raise exception 'forbidden_role';
  end if;

  select * into claim from private.claim_idempotent(m.org_id, 'set_member_locations', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.membership_row, claim.response);
  end if;
  update app.memberships set location_ids = p_location_ids where id = m.id returning * into m;
  perform private.save_idempotent('set_member_locations', p_idempotency_key, to_jsonb(private.membership_row(m)));
  return private.membership_row(m);
end $$;
comment on function api.set_member_locations(uuid, uuid[], uuid) is
  'Sets the locations a member works at (null = every location) and leaves their role alone. '
  'Owners any member, admins managers and staff; nobody changes their own; a location-scoped admin '
  'cannot grant locations beyond their own. Every change is in the audit log. Raises not_found '
  '(unknown or foreign id), permission_denied (below admin), forbidden_role, invalid_location (an '
  'id that is not a location of the org), invalid_input (empty array, no key), org_suspended. '
  'Idempotent per key. Implemented by 2B-ORG1 (#265).';
