-- 2B-Q1 (#226): priority classes (Q-10). A class is an offset subtracted from the visit's arrival
-- time when it is filed, so manual reorder (move_visit) always wins and position stays computed.
--
-- redefines api.move_visit from 20261030055124_move_transfer.sql
-- redefines api.set_visit_priority from 20261030162713_api_contracts_2b.sql

create table app.priority_classes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 60),
  offset_minutes int not null check (offset_minutes between 0 and 720),
  color text check (color ~ '^#[0-9A-Fa-f]{6}$'),
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (org_id, location_id) references app.locations (org_id, id) on delete cascade,
  unique (org_id, id)
);
create index priority_classes_location_idx on app.priority_classes (location_id);

create trigger forbid_org_change before update on app.priority_classes
  for each row execute function private.forbid_org_change();
create trigger audit_row after insert or update or delete on app.priority_classes
  for each row execute function private.audit_row();

alter table app.priority_classes enable row level security;
revoke delete, truncate on app.priority_classes from authenticated;
create policy priority_classes_select on app.priority_classes for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff'))
         or (select private.is_device(org_id, location_id)));
create policy priority_classes_insert on app.priority_classes for insert to authenticated
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy priority_classes_update on app.priority_classes for update to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')))
  with check ((select private.has_role(org_id, location_id, 'manager')));
grant select, insert, update on app.priority_classes to authenticated;

alter table app.visits
  add column priority_class_id uuid,
  add column manually_ordered boolean not null default false,
  add foreign key (org_id, priority_class_id) references app.priority_classes (org_id, id);

/**
 * The sort_key that files a visit among the waiting visits of (queue, service day) by its
 * effective arrival time, joined_at minus the class offset. It goes in front of the first waiting
 * visit (in line order) that arrived effectively later; visits staff placed by hand
 * (manually_ordered) are never used as that landmark, so a manual order is not undone.
 * p_visit_id may be a visit that does not exist yet. May renumber the others (private.place_in_queue).
 */
create function private.priority_sort_key(
  p_queue_id uuid,
  p_service_day date,
  p_visit_id uuid,
  p_joined_at timestamptz,
  p_offset_minutes int
) returns bigint
language plpgsql volatile set search_path = '' as $$
declare
  v_eff timestamptz := p_joined_at - make_interval(mins => coalesce(p_offset_minutes, 0));
  v_first app.visits;
  v_after uuid;
begin
  select w.* into v_first
  from app.visits w
  left join app.priority_classes pc on pc.id = w.priority_class_id
  where w.queue_id = p_queue_id and w.service_day = p_service_day and w.status = 'waiting'
    and w.id <> p_visit_id and not w.manually_ordered
    and w.joined_at - make_interval(mins => coalesce(pc.offset_minutes, 0)) > v_eff
  order by w.sort_key, w.id
  limit 1;

  select w.id into v_after
  from app.visits w
  where w.queue_id = p_queue_id and w.service_day = p_service_day and w.status = 'waiting'
    and w.id <> p_visit_id
    and (v_first.id is null or (w.sort_key, w.id) < (v_first.sort_key, v_first.id))
  order by w.sort_key desc, w.id desc
  limit 1;

  return (select p.new_sort_key from private.place_in_queue(p_queue_id, p_service_day, p_visit_id, v_after) p);
end $$;
comment on function private.priority_sort_key(uuid, date, uuid, timestamptz, int) is
  'The sort_key that files a visit by joined_at minus its class offset among the waiting visits, '
  'skipping manually ordered visits as landmarks. Not exposed.';
revoke all on function private.priority_sort_key(uuid, date, uuid, timestamptz, int) from public, anon, authenticated;

create or replace function api.set_visit_priority(
  p_visit_id uuid,
  p_priority_class_id uuid,
  p_expected_version int,
  p_idempotency_key uuid
) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  pc app.priority_classes;
  claim record;
  v_key bigint;
  result api.visit_row;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_expected_version is null or p_idempotency_key is null then
    raise exception 'invalid_input';
  end if;
  if p_priority_class_id is not null then
    select * into pc from app.priority_classes
    where id = p_priority_class_id and org_id = v.org_id and location_id = v.location_id and active;
    if not found then
      raise exception 'not_found';
    end if;
  end if;

  select * into claim from private.claim_idempotent(v.org_id, 'set_visit_priority', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  select * into v from app.visits where id = p_visit_id for update;
  if v.version <> p_expected_version then
    raise exception 'stale_visit';
  end if;
  if v.status <> 'waiting' then
    raise exception 'illegal_transition' using detail = format('priority from %s', v.status);
  end if;

  if v.priority_class_id is not distinct from p_priority_class_id then
    result := private.visit_row(v.id);
    result.last_event_id := null;
    perform private.save_idempotent('set_visit_priority', p_idempotency_key, to_jsonb(result));
    return result;
  end if;

  v_key := v.sort_key;
  if not v.manually_ordered then
    v_key := private.priority_sort_key(v.queue_id, v.service_day, v.id, v.joined_at, pc.offset_minutes);
  end if;
  perform private.set_actor('staff', (select auth.uid()), 'priority_changed', null,
    jsonb_build_object('from_priority_class_id', v.priority_class_id,
                       'to_priority_class_id', p_priority_class_id,
                       'from_sort_key', v.sort_key, 'to_sort_key', v_key));
  update app.visits set priority_class_id = p_priority_class_id, sort_key = v_key where id = v.id;
  perform private.bump_queue_version(v.queue_id);

  result := private.visit_row(v.id);
  perform private.save_idempotent('set_visit_priority', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.set_visit_priority(uuid, uuid, int, uuid) is
  'Sets or clears (null class) a waiting visit''s priority class and returns its row; '
  'last_event_id is the priority_changed event. Unless staff moved the visit by hand '
  '(move_visit), the visit is refiled by its arrival time minus the class offset; a hand-placed '
  'visit keeps its place. Same class again is a no-op (last_event_id null). Staff of the '
  'location. Raises not_found (unknown or foreign visit, or a class that is inactive or of '
  'another location), stale_visit, illegal_transition unless the visit is waiting, invalid_input '
  'without a version or key. Idempotent per key. Implemented in 2B-Q1 (#226).';

-- A hand move marks the visit so a later priority change keeps its place.
create or replace function api.move_visit(
  p_visit_id uuid,
  p_after_visit_id uuid,
  p_expected_version int,
  p_idempotency_key uuid
) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  a app.visits;
  claim record;
  pl record;
  v_from_after uuid;
  result api.visit_row;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_expected_version is null or p_idempotency_key is null or p_after_visit_id = p_visit_id then
    raise exception 'invalid_input';
  end if;

  select * into claim from private.claim_idempotent(v.org_id, 'move_visit', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  select * into v from app.visits where id = p_visit_id for update;
  if v.version <> p_expected_version then
    raise exception 'stale_visit';
  end if;
  if v.status <> 'waiting' then
    raise exception 'illegal_transition' using detail = format('move from %s', v.status);
  end if;

  if p_after_visit_id is not null then
    select * into a from app.visits
    where id = p_after_visit_id and org_id = v.org_id and queue_id = v.queue_id;
    if not found then
      raise exception 'not_found';
    end if;
    if a.status <> 'waiting' or a.service_day <> v.service_day then
      raise exception 'stale_visit';
    end if;
  end if;

  select w.id into v_from_after
  from app.visits w
  where w.queue_id = v.queue_id and w.service_day = v.service_day and w.status = 'waiting'
    and (w.sort_key, w.id) < (v.sort_key, v.id)
  order by w.sort_key desc, w.id desc
  limit 1;

  -- Already right behind p_after_visit_id (or already first): nothing to do, no event.
  if v_from_after is not distinct from p_after_visit_id then
    result := private.visit_row(v.id);
    result.last_event_id := null;
    perform private.save_idempotent('move_visit', p_idempotency_key, to_jsonb(result));
    return result;
  end if;

  select * into pl from private.place_in_queue(v.queue_id, v.service_day, v.id, p_after_visit_id);
  perform private.set_actor('staff', (select auth.uid()), 'moved', null,
    jsonb_build_object('from_sort_key', v.sort_key, 'to_sort_key', pl.new_sort_key,
                       'from_after_visit_id', v_from_after, 'to_after_visit_id', p_after_visit_id,
                       'renumbered', pl.renumbered));
  update app.visits set sort_key = pl.new_sort_key, manually_ordered = true where id = v.id;
  perform private.bump_queue_version(v.queue_id);

  result := private.visit_row(v.id);
  perform private.save_idempotent('move_visit', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.move_visit(uuid, uuid, int, uuid) is
  'Moves a waiting visit to just after p_after_visit_id in its queue (null = to the front) and '
  'returns its row; last_event_id is the moved event, which undo_event reverses for 10 minutes. '
  'The sort_key becomes the midpoint of the new neighbours; with no gap the queue''s waiting '
  'visits are renumbered in the same transaction (one renumbered event each). Already in that '
  'place is a no-op (last_event_id null). Staff of the location. Raises stale_visit when '
  'p_expected_version is old or p_after_visit_id is no longer waiting, illegal_transition unless '
  'the visit is waiting, invalid_input without a version or key or when after is the visit '
  'itself, not_found for unknown or foreign visits and for an after visit of another queue. '
  'Idempotent per key. Implemented in 2A-ST1 (#134).';
