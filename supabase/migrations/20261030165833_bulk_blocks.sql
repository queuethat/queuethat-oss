-- 2B-A9 (#284): atomic multi-resource, multi-range time blocks with a conflict report.
--
-- The ticket assumed phase-2a "availability blocks" per resource. They do not exist: availability
-- exceptions are per-staff local-time windows. Blocks get their own table, keyed by resource
-- (app.counters). Alternatives weighed: (a) app.time_blocks (chosen: holds tstz ranges and any
-- resource kind, and a bulk create is a plain insert); (b) rows in availability_exceptions (local
-- time on one date, no resource column, cannot span days or be deleted as a batch).
-- Blocks never cancel appointments; an overlapping booked appointment is reported in `conflicts`.
-- Not yet read by api.get_available_slots; the planning-grid ticket (#286) wires that in.

create table app.time_blocks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  counter_id uuid not null,
  during tstzrange not null check (not isempty(during) and not lower_inf(during) and not upper_inf(during)),
  reason text check (length(reason) <= 200),
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (org_id, location_id, counter_id) references app.counters (org_id, location_id, id) on delete cascade
);
create index time_blocks_location_idx on app.time_blocks (location_id);
create index time_blocks_during_idx on app.time_blocks using gist (during);
create index time_blocks_counter_idx on app.time_blocks (counter_id);

create trigger forbid_org_change before update on app.time_blocks
  for each row execute function private.forbid_org_change();

alter table app.time_blocks enable row level security;

create policy time_blocks_select on app.time_blocks for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')));
create policy time_blocks_insert on app.time_blocks for insert to authenticated
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy time_blocks_update on app.time_blocks for update to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')))
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy time_blocks_delete on app.time_blocks for delete to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')));

grant select, insert, update, delete on app.time_blocks to authenticated;
grant all on app.time_blocks to service_role;

create trigger audit_row after insert or update or delete on app.time_blocks
  for each row execute function private.audit_row();

-- redefines api.block_time_bulk from 20261030162713_api_contracts_2b.sql
create or replace function api.block_time_bulk(p_location_id uuid, p_resource_ids uuid[], p_ranges tstzrange[], p_reason text, p_idempotency_key uuid)
returns api.bulk_block_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  claim record;
  res api.bulk_block_result;
  v_resources uuid[];
begin
  select l.org_id into v_org from app.locations l where l.id = p_location_id;
  if v_org is null then raise exception 'not_found'; end if;
  if not private.has_role(v_org, p_location_id, 'manager') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_idempotency_key is null or length(coalesce(v_reason, '')) > 200
     or coalesce(cardinality(p_resource_ids), 0) not between 1 and 50
     or coalesce(cardinality(p_ranges), 0) not between 1 and 50
     or exists (select 1 from unnest(p_ranges) r
                where r is null or isempty(r) or lower_inf(r) or upper_inf(r)) then
    raise exception 'invalid_input';
  end if;

  v_resources := (select array_agg(distinct x) from unnest(p_resource_ids) x);
  if (select count(*) from app.counters c
      where c.id = any (v_resources) and c.org_id = v_org and c.location_id = p_location_id)
     <> cardinality(v_resources) then
    raise exception 'invalid_resource';
  end if;

  select * into claim from private.claim_idempotent(v_org, 'block_time_bulk', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.bulk_block_result, claim.response);
  end if;

  with ins as (
    insert into app.time_blocks (org_id, location_id, counter_id, during, reason, created_by)
    select v_org, p_location_id, c, r, v_reason, (select auth.uid())
    from unnest(v_resources) c cross join unnest(p_ranges) r
    returning id
  )
  select coalesce(array_agg(id), '{}') into res.block_ids from ins;

  -- A booking conflicts when it overlaps a range and needs the blocked resource: the resource is
  -- that staff member's own, or the booking's service is mapped to it.
  select coalesce(array_agg(distinct a.id), '{}') into res.conflicts
  from app.appointments a
  cross join unnest(v_resources) c
  join app.counters ctr on ctr.id = c
  cross join unnest(p_ranges) r
  where a.location_id = p_location_id
    and a.status in ('booked', 'checked_in')
    and tstzrange(a.starts_at, a.ends_at) && r
    and (a.staff_user_id = ctr.member_user_id
         or exists (select 1 from app.service_resources sr
                    where sr.service_id = a.service_id and sr.counter_id = c));

  perform private.save_idempotent('block_time_bulk', p_idempotency_key, to_jsonb(res));
  return res;
end $$;
comment on function api.block_time_bulk(uuid, uuid[], tstzrange[], text, uuid) is
  'Blocks every resource over every range in one transaction (max 50 x 50, bounded ranges). '
  'Returns the created block ids and the ids of booked or checked-in appointments that overlap '
  'a block and need the resource (own staff resource or mapped service); they stay booked. '
  'Manager or above. Raises not_found (location), permission_denied, invalid_input, '
  'invalid_resource (unknown or foreign resource; nothing is created). Idempotent per key. '
  'Implemented by 2B-A9.';

create function api.delete_time_blocks(p_block_ids uuid[], p_idempotency_key uuid)
returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ids uuid[];
  v_org uuid;
  v_found int;
  claim record;
  v_count int;
begin
  if p_idempotency_key is null or coalesce(cardinality(p_block_ids), 0) not between 1 and 2500 then
    raise exception 'invalid_input';
  end if;
  v_ids := (select array_agg(distinct x) from unnest(p_block_ids) x);
  select count(*), (array_agg(org_id))[1] into v_found, v_org
  from app.time_blocks where id = any (v_ids);
  if v_found <> cardinality(v_ids) then
    -- A repeat of a call that already deleted them answers the same way.
    select (k.response #>> '{}')::int into v_count from app.idempotency_keys k
    where k.actor_id = (select auth.uid()) and k.rpc = 'delete_time_blocks'
      and k.key = p_idempotency_key and k.response is not null;
    if v_count is null then raise exception 'not_found'; end if;
    return v_count;
  end if;
  -- No existence leak: a block the caller cannot manage looks like a missing one.
  if exists (select 1 from app.time_blocks b where b.id = any (v_ids)
             and not private.has_role(b.org_id, b.location_id, 'manager')) then
    raise exception 'not_found';
  end if;
  select * into claim from private.claim_idempotent(v_org, 'delete_time_blocks', p_idempotency_key);
  if claim.replay then
    return (claim.response #>> '{}')::int;
  end if;
  delete from app.time_blocks where id = any (v_ids);
  get diagnostics v_count = row_count;
  perform private.save_idempotent('delete_time_blocks', p_idempotency_key, to_jsonb(v_count));
  return v_count;
end $$;
comment on function api.delete_time_blocks(uuid[], uuid) is
  'Deletes time blocks (blocks may be deleted; appointments never are) and returns how many. '
  'Manager or above of every block''s location. Raises not_found (unknown, foreign or not '
  'permitted), invalid_input. Idempotent per key. Added by 2B-A9 as the undo of block_time_bulk.';

revoke all on function api.delete_time_blocks(uuid[], uuid) from public, anon;
grant execute on function api.delete_time_blocks(uuid[], uuid) to authenticated, service_role;
