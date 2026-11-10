-- #603: the health page shows a failed pg_cron job as "Failed" and nothing else, so an operator
-- can't tell a dispatcher that answers 401 (check-dispatcher) from a dead function without
-- database access. A failed job's last error text now rides along, cut to 200 characters.
-- redefines api.platform_health from 20261025004010_platform_stats.sql
create or replace function api.platform_health() returns api.platform_health
language plpgsql stable security definer set search_path = '' as $$
declare
  result api.platform_health;
begin
  perform private.require_platform('support');

  select count(*) filter (where n.status in ('queued', 'failed')),
         count(*) filter (where n.status = 'dead'),
         extract(epoch from now() - min(n.created_at) filter (where n.status in ('queued', 'failed')))::int
    into result.notifications_queued, result.notifications_dead, result.oldest_queued_seconds
  from app.notifications n
  where n.status in ('queued', 'failed', 'dead');

  select coalesce(jsonb_agg(jsonb_build_object(
           'name', j.jobname, 'schedule', j.schedule, 'active', j.active,
           'last_start', r.start_time, 'last_status', r.status,
           'last_message', case when r.status = 'failed' then left(r.return_message, 200) end)
           order by j.jobname), '[]'::jsonb)
    into result.cron_jobs
  from cron.job j
  left join lateral (
    select d.start_time, d.status, d.return_message from cron.job_run_details d
    where d.jobid = j.jobid order by d.runid desc limit 1
  ) r on true;

  select count(distinct e.org_id) into result.orgs_active_today
  from app.visit_events e
  where e.type = 'joined'
    and e.occurred_at >= (now() at time zone 'UTC')::date::timestamp at time zone 'UTC';

  result.as_of := now();
  return result;
end $$;
comment on function api.platform_health() is
  'Support or operator (aal2). Current platform health: notifications waiting to send and dead, '
  'age of the oldest waiting one, last run and status of every pg_cron job (plus the error text, '
  'cut to 200 characters, when that run failed), and how many orgs had a join today (UTC). Counts '
  'and job errors only; no tenant rows. Raises permission_denied (42501).';

-- The reason is written by an operator and often ends in a full stop of its own, so "{reason}."
-- read "review..". Put it on a line of its own instead. Version up, so mail queued from now on
-- uses the new text.
update app.notification_templates
set body = replace(body, 'Reason given: {reason}. ', E'Reason given:\n\n{reason}\n\n'),
    version = version + 1
where org_id is null and channel = 'email'
  and trigger in ('support.break_glass', 'org.ownership_transferred')
  and body like '%Reason given: {reason}. %';
