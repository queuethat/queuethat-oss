-- M1 (#1288): optional queue scope for staff. Scope used to stop at the location, so any staff member
-- could read every queue there, including each guest's form answers. A tenant can now turn on
-- "limit staff to their own lines"; it is off by default, and with it off nothing changes.
--
-- Alternatives (rule 7): a UI-only filter (rejected: the API would still return other lines' guests) vs
-- an org setting plus a per-member queue list enforced in RLS (chosen).
--
-- * app.organizations.scope_staff_to_lines (default false). Admins switch it like other org settings.
-- * app.memberships.queue_ids: null = every queue the member's locations cover. Staff only: a promoted
--   member is unscoped again, so a manager can never be locked out of a line by an old list.
-- * private.has_queue_access(org, queue, min_role) sits beside private.has_role (signature unchanged).
-- * RLS on visits and visit_answers uses it; visit_events and visit_companions read through visits, so
--   they follow. M2 (#1289) enforces the same scope inside the api.* actions.

alter table app.organizations
  add column scope_staff_to_lines boolean not null default false;
comment on column app.organizations.scope_staff_to_lines is
  'When true, a staff member with memberships.queue_ids only sees and acts on those queues. Off by default: staff see every queue at their locations.';
grant update (scope_staff_to_lines) on app.organizations to authenticated;

alter table app.memberships add column queue_ids uuid[];
alter table app.memberships add constraint memberships_queue_ids_staff
  check (queue_ids is null or (role = 'staff' and cardinality(queue_ids) > 0));
comment on column app.memberships.queue_ids is
  'Queues this staff member is limited to when the org turns on scope_staff_to_lines. Null = all queues at their locations. Ignored while the setting is off.';
-- Owners assign scope under the existing owner-only insert/update policies.
grant select (queue_ids) on app.memberships to authenticated;
grant insert (queue_ids), update (queue_ids) on app.memberships to authenticated;

/** A promoted member is unscoped; every listed queue must belong to the member's own org. */
create function private.check_member_queue_ids() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.role <> 'staff' then new.queue_ids := null; end if;
  if new.queue_ids is not null and (
    select count(*) from app.queues q where q.org_id = new.org_id and q.id = any (new.queue_ids)
  ) <> (select count(distinct x) from unnest(new.queue_ids) x) then
    raise exception 'invalid_input' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function private.check_member_queue_ids() from public, anon, authenticated;
create trigger check_queue_ids before insert or update of role, queue_ids on app.memberships
  for each row execute function private.check_member_queue_ids();

-- Delegates to has_role so operator sessions, support grants, MFA caps and org status keep one owner;
-- it only adds the queue narrowing on top. Support users have no membership, so nothing narrows them.
create function private.has_queue_access(p_org_id uuid, p_queue_id uuid, p_min_role app.member_role)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  q app.queues;
  os app.operator_sessions := private.operator_session();
begin
  select * into q from app.queues where id = p_queue_id and org_id = p_org_id;
  if not found or not private.has_role(p_org_id, q.location_id, p_min_role) then
    return false;
  end if;
  return not exists (
    select 1
    from app.organizations o
    join app.memberships m on m.org_id = o.id
    where o.id = p_org_id
      and o.scope_staff_to_lines
      and m.user_id = coalesce(os.operator_user_id, (select auth.uid()))
      and m.queue_ids is not null
      and not (p_queue_id = any (m.queue_ids))
  );
end $$;
comment on function private.has_queue_access(uuid, uuid, app.member_role) is
  'private.has_role at the queue''s location, plus, when the org has scope_staff_to_lines on, the caller''s '
  '(or the operator session''s) queue_ids must be null or contain the queue. With the setting off it equals '
  'has_role at the queue''s location. An unknown queue, or one of another org, is false.';
revoke all on function private.has_queue_access(uuid, uuid, app.member_role) from public, anon;
grant execute on function private.has_queue_access(uuid, uuid, app.member_role) to authenticated, service_role;

drop policy visits_select on app.visits;
create policy visits_select on app.visits for select to authenticated
  using ((select private.has_queue_access(org_id, queue_id, 'staff')));

drop policy visit_answers_select on app.visit_answers;
create policy visit_answers_select on app.visit_answers for select to authenticated
  using (exists (
    select 1 from app.visits v
    where v.id = visit_id and (select private.has_queue_access(v.org_id, v.queue_id, 'staff'))
  ));
