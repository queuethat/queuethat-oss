-- O6 (#77): api.health_report, read by the health Edge Function.
begin;
\ir ../helpers/_setup.psql
select plan(9);

select tests.create_world();

select tests.as_anon();
select throws_ok($$ select api.health_report() $$, '42501', null, 'anon cannot read job health');
select tests.act_as('owner');
select throws_ok($$ select api.health_report() $$, '42501', null,
  'a signed-in owner cannot read job health either');

select tests.as_postgres();
delete from cron.job_run_details
where jobid in (select jobid from cron.job where jobname in ('rollover-tick', 'kick-dispatcher'));
insert into cron.job_run_details (jobid, runid, job_pid, database, username, command, status,
                                  return_message, start_time, end_time)
-- runid by hand: postgres may write the table but not cron's sequence.
select j.jobid, (select coalesce(max(runid), 0) from cron.job_run_details) + s.n, 1, 'postgres', 'postgres', j.command, s.status, '',
       now() - s.ago - interval '1 second', now() - s.ago
from cron.job j
join (values (1, 'rollover-tick', 'succeeded', interval '7 minutes'),
             (2, 'rollover-tick', 'failed', interval '2 minutes'),
             (3, 'kick-dispatcher', 'succeeded', interval '15 seconds')) s(n, job, status, ago)
  on s.job = j.jobname;
-- Sends the seed or an earlier test left due would hide the cases below.
update app.notifications set next_attempt_at = now() + interval '1 day'
where status in ('queued', 'failed') and next_attempt_at <= now();

select tests.as_service();
select is((api.health_report() ->> 'rollover_ok_at')::timestamptz, now() - interval '7 minutes',
  'rollover_ok_at is the last successful tick, not a later failed one');
select is((api.health_report() ->> 'dispatcher_kick_ok_at')::timestamptz,
  now() - interval '15 seconds', 'dispatcher_kick_ok_at is the last successful kick');
select is(api.health_report() -> 'oldest_due_at', 'null'::jsonb, 'nothing is due');

select tests.as_postgres();
select tests.new_visit('v1', 'queue_a');
insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key,
                               template_version, dedupe_key, next_attempt_at)
values (tests.id('org_a'), tests.id('v1'), 'email', gen_random_uuid(), 'called', 1, 'h1',
        now() - interval '11 minutes'),
       (tests.id('org_a'), tests.id('v1'), 'email', gen_random_uuid(), 'called', 1, 'h2',
        now() + interval '1 hour');

select tests.as_service();
select is((api.health_report() ->> 'oldest_due_at')::timestamptz, now() - interval '11 minutes',
  'oldest_due_at is the oldest due send; future retries do not count');
select is((select array_agg(k order by k) from jsonb_object_keys(api.health_report()) k),
  array['checked_at', 'dispatcher_kick_ok_at', 'oldest_due_at', 'rollover_ok_at'],
  'the report holds timestamps only, no tenant data');

-- #550: a fresh deploy whose jobs have never run counts from when they were installed.
select tests.as_postgres();
delete from cron.job_run_details
where jobid in (select jobid from cron.job where jobname in ('rollover-tick', 'kick-dispatcher'));
update private.deployment_settings set jobs_installed_at = now() - interval '3 minutes';
select tests.as_service();
select is((api.health_report() ->> 'rollover_ok_at')::timestamptz, now() - interval '3 minutes',
  'a rollover that has never run reports the install time, so a new deploy is not stale');
select is((api.health_report() ->> 'dispatcher_kick_ok_at')::timestamptz,
  now() - interval '3 minutes', 'so does a kick that has never run');

select * from finish();
rollback;
