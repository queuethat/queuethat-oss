-- V7 (#36): service-day rollover (technical-design.md 3.4, 4.1).
--
-- There is no midnight reset. Ticket counters are keyed by service day, so the only thing left
-- over when a location's day ends is visits nobody finished. A pg_cron tick every 5 minutes
-- closes them for each location whose service day has moved past last_rollover_day:
-- expected, waiting and called visits expire (reason day_end), serving visits are completed with
-- payload auto_closed = true. Nothing is enqueued for guests. Running late or twice is harmless.

------------------------------------------------------------------------------------------------
-- The sweep, with the clock as a parameter so tests can freeze it
------------------------------------------------------------------------------------------------

create function private.rollover(p_at timestamptz) returns int
language plpgsql volatile set search_path = '' as $$
declare
  loc record;
  queue_ids uuid[];
  changed uuid[];
  n int := 0;
begin
  -- SKIP LOCKED: an overlapping tick leaves a location to whichever tick holds it.
  for loc in
    select l.id, private.service_day(l.id, p_at) as today
    from app.locations l
    where l.last_rollover_day is null or l.last_rollover_day < private.service_day(l.id, p_at)
    order by l.id
    for update skip locked
  loop
    perform private.set_actor('system', null, 'expire', 'day_end');
    with x as (
      update app.visits v
      set status = 'expired', finished_at = p_at
      where v.location_id = loc.id and v.service_day < loc.today
        and v.status in ('expected', 'waiting', 'called')
      returning v.queue_id
    )
    select coalesce(array_agg(queue_id), '{}') into queue_ids from x;

    perform private.set_actor('system', null, 'complete', 'day_end', '{"auto_closed": true}');
    with x as (
      update app.visits v
      set status = 'served', finished_at = p_at
      where v.location_id = loc.id and v.service_day < loc.today and v.status = 'serving'
      returning v.queue_id
    )
    select queue_ids || coalesce(array_agg(queue_id), '{}') into changed from x;

    n := n + cardinality(changed);
    perform private.bump_queue_version(q) from (select distinct unnest(changed) as q) d;

    update app.locations set last_rollover_day = loc.today where id = loc.id;
  end loop;
  return n;
end $$;
comment on function private.rollover(timestamptz) is
  'ops.rollover_tick() as of p_at: for each location whose service day at p_at is after '
  'last_rollover_day (or that never rolled over), expires its expected/waiting/called visits of '
  'earlier days with reason day_end, completes serving ones with payload auto_closed = true, '
  'bumps each changed queue''s version once and sets last_rollover_day. Returns visits changed.';

create or replace function ops.rollover_tick() returns int
language sql volatile set search_path = '' as $$
  select private.rollover(now())
$$;
comment on function ops.rollover_tick() is
  'Expires leftover visits for every location whose service day has changed since its last '
  'rollover, and returns how many visits it changed. Idempotent; safe to run late or twice. '
  'Run every 5 minutes by pg_cron (job rollover-tick). Implemented in V7 (#36).';

create function ops.prune_cron_history() returns int
language sql volatile set search_path = '' as $$
  with d as (delete from cron.job_run_details where end_time < now() - interval '7 days' returning 1)
  select count(*)::int from d
$$;
comment on function ops.prune_cron_history() is
  'Deletes pg_cron run history older than 7 days (a 5-minute tick writes 2016 rows a week). '
  'Run daily by pg_cron; returns rows deleted.';

revoke all on function private.rollover(timestamptz) from public, anon, authenticated;
revoke all on function ops.rollover_tick() from public, anon, authenticated;
revoke all on function ops.prune_cron_history() from public, anon, authenticated;

select cron.schedule('rollover-tick', '*/5 * * * *', 'select ops.rollover_tick()');
select cron.schedule('prune-cron-history', '41 3 * * *', 'select ops.prune_cron_history()');

------------------------------------------------------------------------------------------------
-- Rollover bookkeeping is not a configuration change
------------------------------------------------------------------------------------------------

-- Like the queue version bump in V2: without this every location would write an audit row a day.
drop trigger audit_row on app.locations;
create trigger audit_row after insert or delete on app.locations
  for each row execute function private.audit_row();
create trigger audit_row_update after update on app.locations
  for each row
  when ((to_jsonb(old) - 'last_rollover_day' - 'updated_at')
        is distinct from (to_jsonb(new) - 'last_rollover_day' - 'updated_at'))
  execute function private.audit_row();
