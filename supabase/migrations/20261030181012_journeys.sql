-- 2B-Q8 (#233): linear journeys (registration -> triage -> doctor). Model, decided in ADR 0011:
-- a journey step is a transfer to the next queue, recorded as one `transferred` event
-- {journey_id, from_step, to_step, ...} on the same visit, so the guest keeps one token and one
-- status page, and the existing undo for `transferred` events reverses it.
--   * app.journeys / app.journey_steps: the ordered queues. A queue appears once per journey, so
--     the current step is derived from the visit's queue (it stays right after an undo).
--   * services.journey_id: a visit follows its service's journey. visits.journey_id is set at the
--     first advance (join_core is not touched).
--   * api.advance_journey: serving -> waiting in the next step's queue, filed behind everyone
--     already waiting there; on the last step it completes the visit.
--   * The state machine gains no action: visit_action is unchanged and the guard accepts the
--     serving -> waiting change only for a `transferred` event that moves a journey visit between
--     queues. The console gets the next queue from app.staff_visits.journey_next_queue_id.
-- redefines private.guard_visit from 20261030045508_api_contracts_2a.sql
-- redefines app.staff_visits from 20261030115001_guest_snooze_status.sql
-- redefines api.advance_journey from 20261030162713_api_contracts_2b.sql

create table app.journeys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (org_id, location_id) references app.locations (org_id, id) on delete cascade,
  unique (org_id, id)
);

create table app.journey_steps (
  id uuid primary key default gen_random_uuid(),
  journey_id uuid not null,
  org_id uuid not null,
  step_no int not null check (step_no >= 1),
  queue_id uuid not null,
  service_id uuid,
  foreign key (org_id, journey_id) references app.journeys (org_id, id) on delete cascade,
  foreign key (org_id, queue_id) references app.queues (org_id, id) on delete cascade,
  foreign key (service_id) references app.services (id) on delete set null,
  unique (journey_id, step_no),
  unique (journey_id, queue_id)
);

alter table app.services add column journey_id uuid references app.journeys (id) on delete set null;
alter table app.visits add column journey_id uuid references app.journeys (id);
grant select (journey_id) on app.visits to authenticated;

create trigger forbid_org_change before update on app.journeys
  for each row execute function private.forbid_org_change();
create trigger forbid_org_change before update on app.journey_steps
  for each row execute function private.forbid_org_change();
create trigger audit_row after insert or update or delete on app.journeys
  for each row execute function private.audit_row();
create trigger audit_row after insert or update or delete on app.journey_steps
  for each row execute function private.audit_row();

alter table app.journeys enable row level security;
alter table app.journey_steps enable row level security;

create policy journeys_select on app.journeys for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')));
create policy journeys_insert on app.journeys for insert to authenticated
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy journeys_update on app.journeys for update to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')))
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy journeys_delete on app.journeys for delete to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')));

create policy journey_steps_select on app.journey_steps for select to authenticated
  using (exists (select 1 from app.journeys j where j.id = journey_id
                 and (select private.has_role(j.org_id, j.location_id, 'staff'))));
create policy journey_steps_insert on app.journey_steps for insert to authenticated
  with check (exists (select 1 from app.journeys j where j.id = journey_id
                      and (select private.has_role(j.org_id, j.location_id, 'manager'))));
create policy journey_steps_update on app.journey_steps for update to authenticated
  using (exists (select 1 from app.journeys j where j.id = journey_id
                 and (select private.has_role(j.org_id, j.location_id, 'manager'))))
  with check (exists (select 1 from app.journeys j where j.id = journey_id
                      and (select private.has_role(j.org_id, j.location_id, 'manager'))));
create policy journey_steps_delete on app.journey_steps for delete to authenticated
  using (exists (select 1 from app.journeys j where j.id = journey_id
                 and (select private.has_role(j.org_id, j.location_id, 'manager'))));

------------------------------------------------------------------------------------------------
-- Guard: a journey advance may move a serving visit back to waiting
------------------------------------------------------------------------------------------------

-- Same body as 20261030045508_api_contracts_2a.sql; the only change is the journey exception in
-- the final status check.
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

  if act is not null and act = any (enum_range(null::api.visit_action)::text[]) then
    select t.to_status into target
    from app.visit_transitions t
    where t.from_status = old.status and t.action::text = act;
    if target is null or target <> new.status then
      raise exception 'illegal_transition'
        using detail = format('%s -> %s via %s', old.status, new.status, act);
    end if;
  elsif new.status is distinct from old.status
        and not (act = 'transferred' and old.status = 'serving' and new.status = 'waiting'
                 and new.journey_id is not null and new.queue_id is distinct from old.queue_id) then
    raise exception 'illegal_transition'
      using detail = format('%s -> %s without an action', old.status, new.status);
  end if;

  new.version := old.version + 1;
  return new;
end $$;

------------------------------------------------------------------------------------------------
-- The next queue of a visit's journey
------------------------------------------------------------------------------------------------

create function private.journey_next_queue(p_journey_id uuid, p_service_id uuid, p_queue_id uuid)
returns uuid
language sql stable set search_path = '' as $$
  select nx.queue_id
  from app.journey_steps cur
  join app.journeys j on j.id = cur.journey_id and j.active
  join app.journey_steps nx on nx.journey_id = cur.journey_id and nx.step_no = cur.step_no + 1
  where cur.journey_id = coalesce(p_journey_id, (select s.journey_id from app.services s where s.id = p_service_id))
    and cur.queue_id = p_queue_id
$$;
comment on function private.journey_next_queue(uuid, uuid, uuid) is
  'The queue of the step after the visit''s current one (its queue within its journey, which is '
  'the visit''s own or its service''s), or null when there is no journey, it is inactive, or the '
  'visit is on the last step.';
grant execute on function private.journey_next_queue(uuid, uuid, uuid) to authenticated, service_role;

create or replace view app.staff_visits with (security_invoker = true) as
select
  v.id, v.org_id, v.location_id, v.queue_id, v.service_id, v.service_day,
  v.ticket_prefix, v.ticket_number, v.display_ticket, v.status, v.sort_key,
  v.party_size, v.guest_name, v.guest_id, v.contact_id, v.locale, v.source,
  v.counter_id, v.assigned_staff_id, v.call_count, v.eta_quoted_low, v.eta_quoted_high,
  v.joined_at, v.called_at, v.serving_at, v.finished_at, v.version,
  v.guest_phone_e164, v.guest_email,
  private.allowed_actions(v.status) as allowed_actions,
  v.assigned_counter_id,
  v.group_key,
  v.notes,
  v.tags,
  v.scheduled_at,
  v.scheduled_at - make_interval(mins => (select q.early_checkin_minutes from app.queues q where q.id = v.queue_id))
    as arrival_early_until,
  v.scheduled_at + make_interval(mins => (select q.late_tolerance_minutes from app.queues q where q.id = v.queue_id))
    as arrival_late_after,
  private.visit_on_the_way(v.id, v.status, v.call_count) as on_the_way,
  v.journey_id,
  private.journey_next_queue(v.journey_id, v.service_id, v.queue_id) as journey_next_queue_id
from app.visits v;

------------------------------------------------------------------------------------------------
-- api.advance_journey
------------------------------------------------------------------------------------------------

create or replace function api.advance_journey(p_visit_id uuid, p_expected_version int, p_idempotency_key uuid)
returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  claim record;
  pl record;
  v_journey uuid;
  cur app.journey_steps;
  nxt app.journey_steps;
  tq app.queues;
  v_after uuid;
  v_number int;
  v_display text;
  result api.visit_row;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_expected_version is null or p_idempotency_key is null then
    raise exception 'invalid_input';
  end if;

  select * into claim from private.claim_idempotent(v.org_id, 'advance_journey', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  select * into v from app.visits where id = p_visit_id for update;
  if v.version <> p_expected_version then
    raise exception 'stale_visit';
  end if;
  if v.status <> 'serving' then
    raise exception 'illegal_transition' using detail = format('advance from %s', v.status);
  end if;

  v_journey := coalesce(v.journey_id, (select s.journey_id from app.services s where s.id = v.service_id));
  select js.* into cur
  from app.journey_steps js join app.journeys j on j.id = js.journey_id and j.active
  where js.journey_id = v_journey and js.queue_id = v.queue_id;
  if not found then
    raise exception 'illegal_transition' using detail = 'no journey step for this visit';
  end if;
  select * into nxt from app.journey_steps where journey_id = v_journey and step_no = cur.step_no + 1;

  if not found then
    -- The last step is the end of the visit.
    result := api.transition_visit(v.id, 'complete', v.version, gen_random_uuid());
    perform private.save_idempotent('advance_journey', p_idempotency_key, to_jsonb(result));
    return result;
  end if;

  select * into tq from app.queues where id = nxt.queue_id and org_id = v.org_id
    and location_id = v.location_id and archived_at is null;
  if not found then
    raise exception 'not_found';
  end if;

  -- Filed behind everyone already waiting there.
  select w.id into v_after
  from app.visits w
  where w.queue_id = tq.id and w.service_day = v.service_day and w.status = 'waiting'
  order by w.sort_key desc, w.id desc
  limit 1;
  select * into pl from private.place_in_queue(tq.id, v.service_day, v.id, v_after);

  -- The ticket stays unless the target queue issues the same prefix or already holds the number.
  v_number := v.ticket_number;
  v_display := v.display_ticket;
  if tq.ticket_prefix = v.ticket_prefix or exists (
    select 1 from app.visits t
    where t.queue_id = tq.id and t.service_day = v.service_day
      and t.ticket_prefix = v.ticket_prefix and t.ticket_number = v.ticket_number) then
    loop
      v_number := private.next_ticket(tq.id, v.ticket_prefix, v.service_day);
      exit when not exists (
        select 1 from app.visits t
        where t.queue_id = tq.id and t.service_day = v.service_day
          and t.ticket_prefix = v.ticket_prefix and t.ticket_number = v_number);
    end loop;
    v_display := v.ticket_prefix || lpad(v_number::text, greatest(3, length(v_number::text)), '0');
  end if;

  perform private.set_actor('staff', (select auth.uid()), 'transferred', null,
    jsonb_build_object('journey_id', v_journey, 'from_step', cur.step_no, 'to_step', nxt.step_no,
                       'from_queue_id', v.queue_id, 'to_queue_id', tq.id,
                       'from_service_id', v.service_id, 'to_service_id', nxt.service_id,
                       'from_sort_key', v.sort_key, 'to_sort_key', pl.new_sort_key,
                       'from_after_visit_id', null, 'to_after_visit_id', v_after,
                       'from_ticket_number', v.ticket_number, 'to_ticket_number', v_number,
                       'from_display_ticket', v.display_ticket, 'to_display_ticket', v_display,
                       'previous_counter_id', v.counter_id, 'renumbered', pl.renumbered));
  update app.visits
  set status = 'waiting', queue_id = tq.id, service_id = nxt.service_id, sort_key = pl.new_sort_key,
      ticket_number = v_number, display_ticket = v_display, journey_id = v_journey, counter_id = null
  where id = v.id;
  perform private.bump_queue_version(v.queue_id);
  perform private.bump_queue_version(tq.id);

  result := private.visit_row(v.id);
  perform private.save_idempotent('advance_journey', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.advance_journey(uuid, int, uuid) is
  'Sends a serving visit to the next step of its journey (its own, else its service''s): a '
  '`transferred` event {journey_id, from_step, to_step} moves it to that step''s queue and service, '
  'status waiting, filed behind everyone waiting there; the ticket and token stay. On the last '
  'step it completes the visit. Staff of the location. Raises not_found for unknown or foreign '
  'visits, stale_visit, illegal_transition unless serving or when the visit has no active journey '
  'step, invalid_input without version or key. undo_event reverses it for 10 minutes (back to '
  'serving in the previous queue). Idempotent per key. Implemented in 2B-Q8 (#233).';
