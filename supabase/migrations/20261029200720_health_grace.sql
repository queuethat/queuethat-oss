-- #550: on a fresh deploy the jobs have never run, so health answered 503 "rollover" until the
-- first tick. Record when the jobs were installed (this migration's run, for existing installs;
-- the row's default, for new ones) and report that while a job has never succeeded, so a new
-- install is healthy for one threshold and alerts after it if the job still hasn't run.
-- redefines api.health_report from 20261025110433_health_report.sql

alter table private.deployment_settings
  add column jobs_installed_at timestamptz not null default now();

create or replace function api.health_report() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'checked_at', now(),
    'rollover_ok_at', coalesce((
      select d.end_time from cron.job_run_details d join cron.job j on j.jobid = d.jobid
      where j.jobname = 'rollover-tick' and d.status = 'succeeded'
      order by d.runid desc limit 1), (select s.jobs_installed_at from private.deployment_settings s)),
    'dispatcher_kick_ok_at', coalesce((
      select d.end_time from cron.job_run_details d join cron.job j on j.jobid = d.jobid
      where j.jobname = 'kick-dispatcher' and d.status = 'succeeded'
      order by d.runid desc limit 1), (select s.jobs_installed_at from private.deployment_settings s)),
    'oldest_due_at', (
      select min(n.next_attempt_at) from app.notifications n
      where n.status in ('queued', 'failed') and n.next_attempt_at <= now())
  )
$$;
comment on function api.health_report() is
  'Job health for the health Edge Function: {checked_at, rollover_ok_at, dispatcher_kick_ok_at, '
  'oldest_due_at}. The *_ok_at values are when the rollover-tick and kick-dispatcher pg_cron jobs '
  'last succeeded, or when the jobs were installed if they never have, so a fresh deploy is not '
  'stale before its first run. oldest_due_at is the oldest queued or failed notification that is '
  'due now (null if none), so a growing age means sends are stuck. Holds no tenant data or ids. '
  'Service role only.';
