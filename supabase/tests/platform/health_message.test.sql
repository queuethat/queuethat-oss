-- #603: platform_health carries a failed job's error text (cut to 200 characters) and nothing
-- for a job that last succeeded. The break-glass and ownership emails no longer put a full stop
-- after the operator's reason, which usually has one of its own.
begin;
\ir ../helpers/_setup.psql
select plan(7);

select tests.create_world();
select tests.as_postgres();

delete from cron.job_run_details
where jobid in (select jobid from cron.job where jobname in ('check-dispatcher', 'kick-dispatcher'));
insert into cron.job_run_details (jobid, runid, job_pid, database, username, command, status,
                                  return_message, start_time, end_time)
select j.jobid, (select coalesce(max(runid), 0) from cron.job_run_details) + s.n, 1, 'postgres',
       'postgres', j.command, s.status, s.message, now() - interval '1 minute', now()
from cron.job j
join (values (1, 'check-dispatcher', 'failed', 'ERROR: dispatcher answered 401'),
             (2, 'kick-dispatcher', 'succeeded', 'SELECT 1')) s(n, job, status, message)
  on s.job = j.jobname;

select tests.act_as('platform');
select is((select e ->> 'last_message'
           from jsonb_array_elements((api.platform_health()).cron_jobs) e
           where e ->> 'name' = 'check-dispatcher'),
          'ERROR: dispatcher answered 401', 'a failed job carries its error text');
select is((select e ->> 'last_message'
           from jsonb_array_elements((api.platform_health()).cron_jobs) e
           where e ->> 'name' = 'kick-dispatcher'),
          null, 'a job that succeeded carries none');

select tests.as_postgres();
update cron.job_run_details set return_message = repeat('x', 500)
where jobid = (select jobid from cron.job where jobname = 'check-dispatcher');
select tests.act_as('platform');
select is((select length(e ->> 'last_message')
           from jsonb_array_elements((api.platform_health()).cron_jobs) e
           where e ->> 'name' = 'check-dispatcher'),
          200, 'the text is cut to 200 characters');

select tests.act_as('owner');
select throws_ok($$ select api.platform_health() $$, '42501', null,
  'an owner still cannot read platform health');

select tests.as_postgres();
select is((select count(*)::int from app.notification_templates
           where org_id is null and trigger in ('support.break_glass', 'org.ownership_transferred')
             and body like '%{reason}. %'),
          0, 'no template puts a full stop right after the reason');
select is((select count(*)::int from app.notification_templates
           where org_id is null and trigger in ('support.break_glass', 'org.ownership_transferred')
             and body like E'%Reason given:\n\n{reason}\n\n%'),
          2, 'both put the reason on a line of its own');
select ok((select min(version) from app.notification_templates
           where org_id is null and trigger in ('support.break_glass', 'org.ownership_transferred')) >= 2,
  'and their version went up');

select * from finish();
rollback;
