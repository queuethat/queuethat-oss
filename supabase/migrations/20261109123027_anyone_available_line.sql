-- M4 (#1291): the "Anyone available" shared line. A provider has their own line (kind 'provider'); a
-- pool (kind 'pool') holds guests who did not pick anyone. A provider's pulls_from names the pool, and
-- api.call_next serves their own line first, then falls back to the pool. Own-first keeps regulars'
-- waits predictable (product call: plan decision 2, on the #398 decision list).
--
-- Alternatives (rule 7): oldest wait across both lines (rejected: a regular's place depends on strangers
-- joining the pool) vs own line first, then pool (chosen). No signature changes: call_next keeps its
-- parameters, so no new entry point and no client change.
--
-- * app.queues.kind ('general' default | 'provider' | 'pool') and pulls_from (provider -> pool, same location).
-- * api.call_next: falls back to the pool; SKIP LOCKED still gives two callers different guests.
-- * private.has_queue_access: a scoped provider also reaches the pool their line pulls from, so they can
--   act on the guests they were handed (and transfer them on).
-- * private.eta_servers: a pool's servers are its providers' servers_on_duty (presence and shifts still
--   count location-wide as before), so the ETA engine quotes pool guests for the providers who serve them.
--   A provider's own ETA ignores pool guests; that under-quotes slightly and is the cheap, predictable choice.

alter table app.queues
  add column kind text not null default 'general' check (kind in ('general', 'provider', 'pool')),
  add column pulls_from uuid,
  add constraint queues_pulls_from_provider check (pulls_from is null or (kind = 'provider' and pulls_from <> id)),
  add constraint queues_pulls_from_fk foreign key (org_id, location_id, pulls_from)
    references app.queues (org_id, location_id, id);
create index queues_pulls_from_idx on app.queues (pulls_from) where pulls_from is not null;
comment on column app.queues.kind is
  'general = an ordinary line; provider = one person''s line, may pull from a pool; pool = the shared "Anyone available" line.';
comment on column app.queues.pulls_from is
  'For a provider line: the pool (same location) its call_next falls back to once its own line is empty.';

create function private.check_queue_pool() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.pulls_from is not null and not exists (
    select 1 from app.queues p where p.id = new.pulls_from and p.kind = 'pool'
  ) then
    raise exception 'invalid_input';
  end if;
  -- A pool that providers still pull from stays a pool.
  if tg_op = 'UPDATE' and old.kind = 'pool' and new.kind <> 'pool'
     and exists (select 1 from app.queues p where p.pulls_from = old.id) then
    raise exception 'invalid_input';
  end if;
  return new;
end $$;
comment on function private.check_queue_pool() is
  'BEFORE INSERT OR UPDATE on app.queues: pulls_from must point at a pool, and a pool with providers cannot change kind (invalid_input).';
create trigger queues_check_pool before insert or update of kind, pulls_from on app.queues
  for each row execute function private.check_queue_pool();
revoke all on function private.check_queue_pool() from public, anon, authenticated;

-- redefines private.has_queue_access from 20261109085423_queue_scoped_staff.sql
create or replace function private.has_queue_access(p_org_id uuid, p_queue_id uuid, p_min_role app.member_role)
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
      -- M4: the pool a listed provider line pulls from is in scope too.
      and not exists (select 1 from app.queues pq
                      where pq.pulls_from = p_queue_id and pq.id = any (m.queue_ids))
  );
end $$;

-- redefines private.eta_servers from 20261030172714_staff_presence.sql
create or replace function private.eta_servers(p_queue_id uuid) returns int
language sql stable set search_path = '' as $$
  select case
    -- Anyone reporting presence in the last 12 hours switches the location to presence counting.
    when exists (select 1 from app.staff_presence p
                 where p.location_id = q.location_id and p.updated_at > now() - interval '12 hours')
      then (select count(*)::int from app.staff_presence p
            where p.location_id = q.location_id and p.status = 'available'
              and p.updated_at > now() - interval '12 hours')
    when q.use_shift_schedule and private.scheduled_servers(q.location_id) > 0
      then private.scheduled_servers(q.location_id)
    -- M4: a pool is served by the providers who pull from it.
    when q.kind = 'pool'
      then (select coalesce(sum(p.servers_on_duty), 0)::int from app.queues p
            where p.pulls_from = q.id and p.archived_at is null)
    else q.servers_on_duty
  end
  from app.queues q where q.id = p_queue_id
$$;
comment on function private.eta_servers(uuid) is
  'How many servers the ETA divides by. Order: available staff when anyone at the location has '
  'reported presence in the last 12 hours (zero = unstaffed), else staff on shift now when the '
  'queue uses the shift schedule and anyone is scheduled, else for a pool the summed servers_on_duty '
  'of the provider lines that pull from it, else servers_on_duty. Null for an unknown queue.';

-- redefines api.call_next from 20261109102446_queue_scope_actions.sql
create or replace function api.call_next(p_queue_id uuid, p_counter_id uuid, p_idempotency_key uuid)
returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  q app.queues;
  claim record;
  src record;
  v_id uuid;
  result api.visit_row;
begin
  if p_idempotency_key is null then
    raise exception 'invalid_input';
  end if;

  select * into q from app.queues where id = p_queue_id;
  if not found or not private.has_queue_access(q.org_id, q.id, 'staff') then
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

  -- Own line first, then the pool it pulls from (M4: "Anyone available"). A provider with an empty line
  -- takes the longest-waiting pool guest. SKIP LOCKED: a concurrent caller holding the first eligible
  -- visit makes us take the next one, in either line, so two providers never get the same guest.
  -- NO KEY UPDATE, not UPDATE: a foreign-key check's KEY SHARE on the row must not make us skip it.
  for src in
    select s.id, s.max_walkin_delay_minutes
    from app.queues s
    where s.id = q.id
       or (s.id = q.pulls_from and s.kind = 'pool' and s.org_id = q.org_id and s.archived_at is null)
    order by (s.id = q.id) desc
  loop
    select v.id into v_id
    from app.visits v
    where v.queue_id = src.id
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
                          + make_interval(mins => coalesce(v.eta_quoted_high, 0) + src.max_walkin_delay_minutes)) desc,
             v.sort_key, v.id
    limit 1
    for no key update skip locked;
    exit when v_id is not null;
  end loop;

  if v_id is null then
    perform private.save_idempotent('call_next', p_idempotency_key, null);
    return null;
  end if;

  perform private.set_actor('staff', (select auth.uid()), 'call', null,
                            jsonb_strip_nulls(jsonb_build_object('counter_id', p_counter_id)));
  update app.visits
  set status = 'called', called_at = now(), call_count = call_count + 1, counter_id = p_counter_id
  where id = v_id;
  perform private.bump_queue_version((select v.queue_id from app.visits v where v.id = v_id));

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
  'of the caller) is mapped to it. A provider line that pulls from a pool (queues.pulls_from) serves its '
  'own line first and falls back to the pool when nobody eligible is left. Concurrent callers always get '
  'different visits; repeating a key returns the first result, including a null one. Raises not_found for '
  'a queue or counter outside the caller''s locations or queue scope (staff or above), permission_denied '
  'without visits.call, invalid_input without a key. A visit assigned to p_counter_id is offered before unassigned ones.';
