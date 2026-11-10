-- O6 (#77): what the `health` Edge Function needs to say whether the background jobs are alive.
-- An RPC because it reads pg_cron's run history and the outbox across every tenant, which
-- PostgREST can't expose; only the service role may call it. The endpoint is public, so the job
-- lookups walk cron's primary key backwards (`order by runid desc limit 1`) instead of scanning a
-- week of run history.

create function api.health_report() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'checked_at', now(),
    'rollover_ok_at', (
      select d.end_time from cron.job_run_details d join cron.job j on j.jobid = d.jobid
      where j.jobname = 'rollover-tick' and d.status = 'succeeded'
      order by d.runid desc limit 1),
    'dispatcher_kick_ok_at', (
      select d.end_time from cron.job_run_details d join cron.job j on j.jobid = d.jobid
      where j.jobname = 'kick-dispatcher' and d.status = 'succeeded'
      order by d.runid desc limit 1),
    'oldest_due_at', (
      select min(n.next_attempt_at) from app.notifications n
      where n.status in ('queued', 'failed') and n.next_attempt_at <= now())
  )
$$;
comment on function api.health_report() is
  'Job health for the health Edge Function: {checked_at, rollover_ok_at, dispatcher_kick_ok_at, '
  'oldest_due_at}. The *_ok_at values are when the rollover-tick and kick-dispatcher pg_cron jobs '
  'last succeeded (null if never). oldest_due_at is the oldest queued or failed notification '
  'that is due now (null if none), so a growing age means sends are stuck. Holds no tenant data '
  'or ids. Service role only.';

revoke all on function api.health_report() from public, anon, authenticated;
grant execute on function api.health_report() to service_role;
