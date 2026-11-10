-- 2A-Q6 (#105): grace period, no-show warning and the automatic no-show sweep (Q-13, S-17).
--
-- redefines api.undo_event from 20261030055124_move_transfer.sql
-- Only change there: an automatic grace_expired no-show may be undone like a staff action.

alter table app.queues
  add column auto_no_show_enabled boolean not null default false,
  add column grace_minutes int not null default 5 check (grace_minutes between 1 and 120),
  add column no_show_warning_seconds int not null default 60 check (no_show_warning_seconds >= 20),
  -- null = 2 x the service's expected minutes, at least 15 (read by the console, 2A-ST11)
  add column serving_reminder_minutes int check (serving_reminder_minutes >= 15),
  add constraint queues_warning_before_grace check (no_show_warning_seconds < grace_minutes * 60);

-- When a called guest is marked no-show automatically. Extended by every call and recall, and
-- by on_my_way (2A-GST1). Hidden from API roles until the console needs it.
alter table app.visits add column grace_until timestamptz;

create function private.set_grace_until() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'called' and (old.status <> 'called' or new.call_count > old.call_count) then
    new.grace_until := now() + make_interval(mins => (select q.grace_minutes from app.queues q where q.id = new.queue_id));
  elsif new.status <> 'called' then
    new.grace_until := null;
  end if;
  return new;
end $$;
comment on function private.set_grace_until() is
  'BEFORE UPDATE trigger on app.visits: entering called, or calling again, starts the queue''s grace '
  'period from now; leaving called clears it. The one place grace_until is computed, so call_next, '
  'transition_visit and undo cannot forget it.';
create trigger set_grace_until before update on app.visits
  for each row execute function private.set_grace_until();

------------------------------------------------------------------------------------------------
-- The sweep, with the clock as a parameter so tests can freeze it
------------------------------------------------------------------------------------------------

create function private.no_show_sweep(p_at timestamptz) returns int
language plpgsql volatile set search_path = '' as $$
declare
  r record;
  n int := 0;
begin
  -- SKIP LOCKED: an overlapping tick leaves a visit to whichever tick holds it.
  for r in
    select v.id, v.queue_id, v.counter_id, v.grace_until, q.no_show_warning_seconds
    from app.visits v
    join app.queues q on q.id = v.queue_id
    where v.status = 'called' and v.grace_until is not null
      and q.auto_no_show_enabled and q.manual_state <> 'paused'
      and v.grace_until - make_interval(secs => q.no_show_warning_seconds) <= p_at
    order by v.grace_until, v.id
    for no key update of v skip locked
  loop
    if r.grace_until <= p_at then
      perform private.set_actor('system', null, 'no_show', 'grace_expired',
                                jsonb_strip_nulls(jsonb_build_object('previous_counter_id', r.counter_id)));
      update app.visits set status = 'no_show', finished_at = p_at where id = r.id;
      perform private.bump_queue_version(r.queue_id);
      n := n + 1;
    elsif not exists (
      select 1 from app.visit_events e
      where e.visit_id = r.id and e.type = 'no_show_warning'
        and (e.payload ->> 'grace_until')::timestamptz = r.grace_until
    ) then
      perform private.set_actor('system', null, null, null);
      perform private.record_visit_event(r.id, 'no_show_warning',
                                         jsonb_build_object('grace_until', r.grace_until));
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
comment on function private.no_show_sweep(timestamptz) is
  'ops.no_show_tick() as of p_at. For called visits of queues with auto no-show on (and not '
  'paused): writes one no_show_warning event per grace window once p_at is within '
  'no_show_warning_seconds of grace_until, and marks the visit no_show (actor system, reason '
  'grace_expired) once p_at reaches grace_until. Returns events written plus visits changed. '
  'Idempotent; safe to run late or twice.';

create function ops.no_show_tick() returns int
language sql volatile set search_path = '' as $$
  select private.no_show_sweep(now())
$$;
comment on function ops.no_show_tick() is
  'Warns called guests whose grace period is nearly over and marks them no-show when it ends, for '
  'queues with auto no-show on. Returns the number of events and changes. Run every minute by '
  'pg_cron (job no-show-tick). Not exposed through the API.';
revoke all on function ops.no_show_tick() from public, anon, authenticated;
revoke all on function private.no_show_sweep(timestamptz) from public, anon, authenticated;
revoke all on function private.set_grace_until() from public, anon, authenticated;

select cron.schedule('no-show-tick', '* * * * *', 'select ops.no_show_tick()');

------------------------------------------------------------------------------------------------
-- undo_event
------------------------------------------------------------------------------------------------

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
  if (e.actor_kind not in ('staff', 'platform')
      and not (e.actor_kind = 'system' and e.type = 'no_show' and e.reason = 'grace_expired'))
     or e.type not in ('call', 'recall', 'start', 'requeue', 'complete', 'no_show', 'cancel',
                       'remove', 'reinstate', 'check_in', 'moved', 'transferred')
     or e.undone_by_event_id is not null
     or e.occurred_at < now() - interval '10 minutes'
     or e.id <> (select max(x.id) from app.visit_events x where x.visit_id = v.id) then
    raise exception 'undo_not_allowed';
  end if;

  prior := private.undo_target(v, e);
  if e.type in ('moved', 'transferred') then
    prior.sort_key := private.restore_sort_key(prior, e);
  end if;
  perform private.set_actor('staff', (select auth.uid()), 'undo', null,
                            jsonb_build_object('undoes_event_id', e.id, 'undoes_type', e.type));
  update app.visits
  set status = prior.status,
      queue_id = prior.queue_id,
      service_id = prior.service_id,
      sort_key = prior.sort_key,
      ticket_number = prior.ticket_number,
      display_ticket = prior.display_ticket,
      counter_id = prior.counter_id,
      call_count = prior.call_count,
      called_at = prior.called_at,
      serving_at = prior.serving_at,
      assigned_staff_id = prior.assigned_staff_id,
      finished_at = prior.finished_at
  where id = v.id;
  perform private.bump_queue_version(v.queue_id);
  if prior.queue_id <> v.queue_id then
    perform private.bump_queue_version(prior.queue_id);
  end if;

  result := private.visit_row(v.id);
  update app.visit_events set undone_by_event_id = result.last_event_id where id = e.id;
  perform private.save_idempotent('undo_event', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.undo_event(bigint, uuid) is
  'Reverses a staff action on a visit (call, recall, start, requeue, complete, no_show, cancel, '
  'remove, reinstate, check_in, moved, transferred) by writing a compensating ''undo'' event and '
  'restoring the previous status, counter, call count and timestamps; the place in line is '
  'unchanged, so a visit called by mistake is waiting where it was. A moved or transferred visit '
  'goes back to its queue, service, ticket and place (filed after its old predecessor if the '
  'exact place was taken). The original event gets undone_by_event_id. '
  'Returns the updated row. Repeating a key returns the first result. Raises not_found for an '
  'event outside the caller''s locations (staff or above; no existence leak), invalid_input '
  'without a key, undo_not_allowed when the event is not the visit''s latest (anything changed '
  'since, including an earlier undo), is older than 10 minutes, is not a staff action '
  '(support actions through a grant count as staff actions; the automatic grace_expired no-show counts too), or a moved or renumbered place '
  'cannot be restored because its old predecessor left the line. '
  'Implemented in V3 (#32), extended in 2A-ST1 (#134) and 2A-Q6 (#105).';

notify pgrst, 'reload schema';
