-- 4-RBAC1 (#373): custom roles with granular permissions.
--
-- Interface choice (technical-design 3.5, CLAUDE.md rule 7):
--   A. (chosen) A custom role is an overlay on a staff membership. private.has_role is untouched; the
--      guards of the destructive RPCs move to private.has_permission. Built-in roles map to
--      permissions by the role ladder (private.permission_catalogue.min_role), so they behave exactly
--      as before. A custom role holds only grantable catalogue permissions and replaces the staff
--      defaults for those permissions; its holder is a staff member for everything else (RLS, reads).
--   B. Replace memberships.role with a permission set. Rejected: every policy and function that calls
--      has_role would have to change at once, and a bug would widen access instead of narrowing it.
-- Owner stays non-customisable; a custom role can never hold a permission above manager unless the
-- catalogue marks it grantable, and members.manage is not grantable.

create table private.permission_catalogue (
  permission text primary key,
  min_role app.member_role not null,
  grantable boolean not null,
  description text not null
);
comment on table private.permission_catalogue is
  'The fixed set of permissions. A built-in role holds a permission when it is at least min_role; '
  'a custom role holds it only when listed and grantable.';
insert into private.permission_catalogue (permission, min_role, grantable, description) values
  ('visits.call', 'staff', true, 'Call the next guest and recall a guest'),
  ('visits.remove', 'staff', true, 'Remove or cancel a guest in the queue'),
  ('payments.charge', 'manager', true, 'Charge a no-show fee to a held or stored card'),
  ('payments.refund', 'manager', true, 'Refund a payment'),
  ('settings.integrations', 'admin', true, 'Manage webhooks, API keys and channel settings'),
  ('members.manage', 'admin', false, 'Invite, change and remove members');

create table app.custom_roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  permissions text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (org_id, id)
);
create unique index custom_roles_name_idx on app.custom_roles (org_id, lower(btrim(name)));

/** Permissions must come from the catalogue, be grantable and appear once. */
create function private.validate_custom_role() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.name := btrim(new.name);
  if exists (select 1 from unnest(new.permissions) p
             where not exists (select 1 from private.permission_catalogue c where c.permission = p and c.grantable))
     or (select count(distinct p) from unnest(new.permissions) p) <> coalesce(array_length(new.permissions, 1), 0) then
    raise exception 'invalid_input';
  end if;
  return new;
end $$;
comment on function private.validate_custom_role() is
  'Rejects a custom role whose permissions are not all grantable catalogue entries, or repeat.';
revoke all on function private.validate_custom_role() from public, anon, authenticated;
create trigger validate_custom_role before insert or update on app.custom_roles
  for each row execute function private.validate_custom_role();
create trigger forbid_org_change before update on app.custom_roles
  for each row execute function private.forbid_org_change();
create trigger audit_row after insert or update or delete on app.custom_roles
  for each row execute function private.audit_row();

alter table app.custom_roles enable row level security;
create policy custom_roles_select on app.custom_roles for select to authenticated
  using ((select private.has_role(org_id, null, 'staff')));
create policy custom_roles_insert on app.custom_roles for insert to authenticated
  with check ((select private.has_role(org_id, null, 'owner')));
create policy custom_roles_update on app.custom_roles for update to authenticated
  using ((select private.has_role(org_id, null, 'owner')))
  with check ((select private.has_role(org_id, null, 'owner')));
create policy custom_roles_delete on app.custom_roles for delete to authenticated
  using ((select private.has_role(org_id, null, 'owner')));

-- A role in use cannot be deleted (restrict), so a delete never silently widens anyone's access.
alter table app.memberships add column custom_role_id uuid;
alter table app.memberships add constraint memberships_custom_role_fk
  foreign key (org_id, custom_role_id) references app.custom_roles (org_id, id) on delete restrict;
alter table app.memberships add constraint memberships_custom_role_staff
  check (custom_role_id is null or role = 'staff');

/** A promoted member is no longer a custom-role member: owners cannot be customised, and the ladder wins. */
create function private.clear_custom_role_on_promotion() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.role <> 'staff' then new.custom_role_id := null; end if;
  return new;
end $$;
revoke all on function private.clear_custom_role_on_promotion() from public, anon, authenticated;
create trigger clear_custom_role before insert or update of role on app.memberships
  for each row execute function private.clear_custom_role_on_promotion();

create function private.has_permission(p_org_id uuid, p_location_id uuid, p_permission text)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  cat private.permission_catalogue;
  os app.operator_sessions := private.operator_session();
begin
  select * into cat from private.permission_catalogue where permission = p_permission;
  if not found then return false; end if; -- an unknown permission is never held
  if exists (
    select 1
    from app.memberships m
    join app.custom_roles r on r.org_id = m.org_id and r.id = m.custom_role_id
    join app.organizations o on o.id = m.org_id
    where m.user_id = coalesce(os.operator_user_id, (select auth.uid()))
      and m.org_id = p_org_id
  ) then
    -- A custom-role member: the role's list is the whole answer, under the same caps as has_role.
    if os.id is not null and (os.org_id <> p_org_id or (p_location_id is not null and p_location_id <> os.location_id)) then
      return false;
    end if;
    return exists (
      select 1
      from app.memberships m
      join app.custom_roles r on r.org_id = m.org_id and r.id = m.custom_role_id
      join app.organizations o on o.id = m.org_id
      where m.user_id = coalesce(os.operator_user_id, (select auth.uid()))
        and m.org_id = p_org_id
        and p_permission = any (r.permissions)
        and (m.location_ids is null or p_location_id is null or p_location_id = any (m.location_ids))
        and (o.status = 'active' or cat.min_role = 'staff')
        -- an operator PIN or an unverified session never reaches above manager
        and (cat.min_role <= 'manager'
             or (os.id is null and (not o.require_mfa_for_admins or coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2')))
    );
  end if;
  return private.has_role(p_org_id, p_location_id, cat.min_role);
end $$;
comment on function private.has_permission(uuid, uuid, text) is
  'True when the caller holds the catalogue permission at the location (null = any). A built-in role '
  'holds it when its rung of the ladder reaches the permission''s min_role, exactly as private.has_role '
  '(support grants, operator cap, MFA cap and suspension included). A member with a custom role holds '
  'only the permissions the role lists, at the locations of their membership; operator sessions and '
  'unverified-MFA sessions are capped at manager-level permissions; a suspended org passes staff-level '
  'ones only. An unknown permission is false.';
revoke all on function private.has_permission(uuid, uuid, text) from public, anon;
grant execute on function private.has_permission(uuid, uuid, text) to authenticated, service_role;

create function private.payment_for_permission(p_payment_id uuid, p_permission text) returns app.payments
language plpgsql stable security definer set search_path = '' as $$
declare
  p app.payments;
begin
  select * into p from app.payments where id = p_payment_id;
  if not found or not private.has_role(p.org_id, p.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if not private.has_permission(p.org_id, p.location_id, p_permission) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  return p;
end $$;
comment on function private.payment_for_permission(uuid, text) is
  'The payment when the caller may see it (staff of its location, else not_found) and holds the permission (else permission_denied). Replaces payment_for_manager.';
revoke all on function private.payment_for_permission(uuid, text) from public, anon, authenticated;

-- redefines api.call_next from 20261030175433_counter_assignment.sql
create or replace function api.call_next(p_queue_id uuid, p_counter_id uuid, p_idempotency_key uuid)
returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  q app.queues;
  claim record;
  v_id uuid;
  result api.visit_row;
begin
  if p_idempotency_key is null then
    raise exception 'invalid_input';
  end if;

  select * into q from app.queues where id = p_queue_id;
  if not found or not private.has_role(q.org_id, q.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if not private.has_permission(q.org_id, q.location_id, 'visits.call') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_counter_id is not null and not exists (
    select 1 from app.counters c
    where c.id = p_counter_id and c.org_id = q.org_id and c.location_id = q.location_id
      and c.archived_at is null
  ) then
    raise exception 'not_found';
  end if;

  select * into claim from private.claim_idempotent(q.org_id, 'call_next', p_idempotency_key);
  if claim.replay then
    return case when claim.response is null or claim.response = 'null' then null
                else jsonb_populate_record(null::api.visit_row, claim.response) end;
  end if;

  -- SKIP LOCKED: a concurrent caller holding the first eligible visit makes us take the next one.
  -- NO KEY UPDATE, not UPDATE: a foreign-key check's KEY SHARE on the row must not make us skip it.
  select v.id into v_id
  from app.visits v
  where v.queue_id = q.id
    and v.status = 'waiting'
    and v.service_day = private.service_day(q.location_id)
    and private.visit_eligible(v.service_id, v.assigned_counter_id, v.assigned_staff_id,
                               p_counter_id, (select auth.uid()))
  -- A walk-in that has waited past its quote plus the queue's max delay goes before appointments
  -- (ADR 0010 guard); otherwise by position.
  -- The wait counts from the last time the guest entered the line (join, snooze, requeue, move,
  -- reinstate), so a snooze or a step back is not undone by the guard.
  order by coalesce(v.assigned_counter_id = p_counter_id, false) desc,
           (v.scheduled_at is null
            and now() > greatest(v.joined_at, coalesce((select max(e.occurred_at) from app.visit_events e
                                                         where e.visit_id = v.id and e.to_status = 'waiting'
                                                           and e.type in ('requeue', 'snoozed', 'moved', 'reinstate', 'undo', 'transferred')), v.joined_at))
                        + make_interval(mins => coalesce(v.eta_quoted_high, 0) + q.max_walkin_delay_minutes)) desc,
           v.sort_key, v.id
  limit 1
  for no key update skip locked;

  if v_id is null then
    perform private.save_idempotent('call_next', p_idempotency_key, null);
    return null;
  end if;

  perform private.set_actor('staff', (select auth.uid()), 'call', null,
                            jsonb_strip_nulls(jsonb_build_object('counter_id', p_counter_id)));
  update app.visits
  set status = 'called', called_at = now(), call_count = call_count + 1, counter_id = p_counter_id
  where id = v_id;
  perform private.bump_queue_version(q.id);

  result := private.visit_row(v_id);
  perform private.save_idempotent('call_next', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.call_next(uuid, uuid, uuid) is
  'Calls the first eligible waiting visit of the queue''s current service day, by position, to '
  'p_counter_id (or to no counter when null) and returns it, or null when nobody eligible is '
  'waiting. A walk-in that has waited longer than its quote plus queues.max_walkin_delay_minutes '
  '(counted from when it last entered the line) goes first. Eligible: unassigned or assigned to that '
  'counter or to the caller, and the service has no mapped resources or the counter (or a staff resource '
  'of the caller) is mapped to it. Concurrent callers always get different visits; repeating a key returns '
  'the first result, including a null one. Raises not_found for a queue or counter outside the caller''s '
  'locations (staff or above), invalid_input without a key. Implemented in V2 (#31), 2A-Q2 (#101), ADR 0010. A visit assigned to p_counter_id is offered before unassigned ones (2B-Q5, #230). Needs the visits.call permission (custom roles, 4-RBAC1); raises permission_denied without it.';

-- redefines api.transition_visit from 20261030173220_api_v1_write.sql
create or replace function api.transition_visit(
  p_visit_id uuid,
  p_action api.visit_action,
  p_expected_version int,
  p_idempotency_key uuid,
  p_counter_id uuid default null,
  p_reason text default null
) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  -- Custom roles (4-RBAC1) can withhold calling and taking a guest off the line (remove, cancel); every other action stays staff-level.
  if (p_action in ('call', 'recall') and not private.has_permission(v.org_id, v.location_id, 'visits.call'))
     or (p_action in ('remove', 'cancel') and not private.has_permission(v.org_id, v.location_id, 'visits.remove')) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  return private.transition_core(p_visit_id, p_action, p_expected_version, p_idempotency_key,
                                 p_counter_id, p_reason, 'staff', (select auth.uid()));
end $$;
comment on function api.transition_visit(uuid, api.visit_action, int, uuid, uuid, text) is
  'Applies one staff action from the visit''s allowed_actions (call, recall, start, requeue, '
  'complete, no_show, cancel, remove, reinstate, check_in) and returns the updated row. call and '
  'recall add to call_count and take p_counter_id (default: the current counter); call sets '
  'called_at, start sets serving_at and assigns the caller; served, no_show, cancelled and '
  'removed set finished_at; back to waiting (requeue, reinstate) keeps the place in line and '
  'clears the counter. check_in turns an expected visit into a waiting one at the place its '
  'scheduled_at earns, or at the end of the line when it is more than the queue''s '
  'late_tolerance_minutes late (the event then carries late = true). A call outside the '
  'eligibility rules (resource, counter or staff assignment) is recorded as an override. '
  'p_reason is recorded on the event. Repeating a key returns the first result. Raises not_found '
  'for a visit or counter outside the caller''s locations (no existence leak), invalid_input '
  'when remove has no reason or a reason is over 500 characters, stale_visit when '
  'p_expected_version is not current (refetch and retry; nothing changes), illegal_transition '
  'when the action is not allowed from the current status. Implemented in V2 (#31), check_in in '
  '2A-CHK1 (#149). call and recall need visits.call and remove and cancel need visits.remove (custom roles, 4-RBAC1; built-in staff hold both); raises permission_denied without them.';

-- redefines api.staff_charge_no_show from 20261030214411_payments_core.sql
create or replace function api.staff_charge_no_show(p_payment_id uuid, p_idempotency_key uuid) returns api.payment_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  p app.payments;
  claim record;
  v_no_show boolean;
begin
  if p_idempotency_key is null then raise exception 'invalid_input'; end if;
  p := private.payment_for_permission(p_payment_id, 'payments.charge');
  select * into claim from private.claim_idempotent(p.org_id, 'staff_charge_no_show', p_idempotency_key);
  if claim.replay then
    if (claim.response ->> 'id')::uuid is distinct from p.id then raise exception 'invalid_input'; end if;
    return jsonb_populate_record(null::api.payment_row, claim.response);
  end if;
  select coalesce(
           (select v.status = 'no_show' from app.visits v where v.org_id = p.org_id and v.id = p.visit_id),
           (select a.status = 'no_show' or v.status = 'no_show'
            from app.appointments a left join app.visits v on v.org_id = a.org_id and v.id = a.visit_id
            where a.org_id = p.org_id and a.id = p.appointment_id),
           false)
    into v_no_show;
  if not v_no_show or p.kind not in ('hold', 'card_on_file') or p.status <> 'authorized' or p.amount_minor <= 0
     or exists (select 1 from app.payment_jobs j where j.payment_id = p.id and j.action = 'release') then
    raise exception 'illegal_payment_action';
  end if;
  insert into app.payment_jobs (org_id, location_id, payment_id, action, amount_minor, dedupe_key)
  values (p.org_id, p.location_id, p.id, 'charge_no_show', p.amount_minor, 'charge:' || p.id)
  on conflict (dedupe_key) do nothing;
  insert into app.audit_log (org_id, actor, role, action, table_name, row_id, after)
  values (p.org_id, (select auth.uid()),
          (select m.role::text from app.memberships m where m.user_id = (select auth.uid()) and m.org_id = p.org_id),
          'UPDATE', 'payments', p.id::text, jsonb_build_object('event', 'charge_no_show', 'amount_minor', p.amount_minor));
  perform private.save_idempotent('staff_charge_no_show', p_idempotency_key, to_jsonb(private.payment_row(p)));
  return private.payment_row(p);
end $$;
comment on function api.staff_charge_no_show(uuid, uuid) is
  'Queues the no-show fee on a held or stored card (the job runner captures or charges it). Manager '
  'or above of the payment''s location. Raises not_found (also for another tenant), permission_denied, '
  'illegal_payment_action (visit is not a no-show, or the payment is not an authorized hold or saved '
  'card), invalid_input. Idempotent per key and per payment. Implemented by 3-PAY2 (#363). Needs the payments.charge permission (manager, or a custom role that holds it).';

-- redefines api.staff_refund_payment from 20261030214411_payments_core.sql
create or replace function api.staff_refund_payment(p_payment_id uuid, p_amount_minor bigint, p_reason text, p_idempotency_key uuid) returns api.payment_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  p app.payments;
  claim record;
  v_amount bigint;
  v_left bigint;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_idempotency_key is null or length(coalesce(v_reason, '')) > 200
     or (p_amount_minor is not null and p_amount_minor <= 0) then
    raise exception 'invalid_input';
  end if;
  p := private.payment_for_permission(p_payment_id, 'payments.refund');
  select * into claim from private.claim_idempotent(p.org_id, 'staff_refund_payment', p_idempotency_key);
  if claim.replay then
    if (claim.response ->> 'id')::uuid is distinct from p.id then raise exception 'invalid_input'; end if;
    return jsonb_populate_record(null::api.payment_row, claim.response);
  end if;
  -- Serialize refunds of one payment, and count refunds already queued but not yet reported.
  select * into p from app.payments where id = p.id for update;
  v_left := p.amount_minor - p.refunded_minor - coalesce(
    (select sum(j.amount_minor) from app.payment_jobs j
     where j.payment_id = p.id and j.action = 'refund' and j.status in ('queued', 'claimed')), 0);
  v_amount := coalesce(p_amount_minor, v_left);
  if p.status not in ('succeeded', 'captured') or v_amount <= 0 or v_amount > v_left then
    raise exception 'illegal_payment_action';
  end if;
  insert into app.payment_jobs (org_id, location_id, payment_id, action, amount_minor, dedupe_key)
  values (p.org_id, p.location_id, p.id, 'refund', v_amount, 'refund:' || p.id || ':' || p_idempotency_key)
  on conflict (dedupe_key) do nothing;
  insert into app.audit_log (org_id, actor, role, action, table_name, row_id, after)
  values (p.org_id, (select auth.uid()),
          (select m.role::text from app.memberships m where m.user_id = (select auth.uid()) and m.org_id = p.org_id),
          'UPDATE', 'payments', p.id::text, jsonb_build_object('event', 'refund', 'amount_minor', v_amount, 'reason', v_reason));
  perform private.save_idempotent('staff_refund_payment', p_idempotency_key, to_jsonb(private.payment_row(p)));
  return private.payment_row(p);
end $$;
comment on function api.staff_refund_payment(uuid, bigint, text, uuid) is
  'Queues a full (null amount) or partial refund of a succeeded or captured payment. Manager or above '
  'of the payment''s location. Raises not_found (also for another tenant), permission_denied, '
  'invalid_input, illegal_payment_action (not refundable, or more than is left). Idempotent per key. '
  'Implemented by 3-PAY2 (#363). Needs the payments.refund permission (manager, or a custom role that holds it).';
