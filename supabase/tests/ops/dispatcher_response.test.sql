-- #583: a dispatcher that answers 401, or never answers, fails the check job, and a later 2xx
-- clears it. pg_cron would otherwise report the kick job as succeeded either way.
begin;
\ir ../helpers/_setup.psql
select plan(9);

select tests.create_world();

select tests.as_postgres();
delete from net._http_response;

select lives_ok($$ select ops.check_dispatcher_response() $$, 'no response yet is fine');

insert into net._http_response (id, status_code, created) values (9001, 200, now());
select lives_ok($$ select ops.check_dispatcher_response() $$, 'a 200 is fine');

insert into net._http_response (id, status_code, created) values (9002, 401, now());
select throws_ok($$ select ops.check_dispatcher_response() $$, 'P0001', 'dispatcher answered 401',
  'a 401 as the newest response fails the job');

insert into net._http_response (id, status_code, created) values (9003, 503, now());
select throws_ok($$ select ops.check_dispatcher_response() $$, 'P0001', 'dispatcher answered 503',
  'a 503 fails it too');

insert into net._http_response (id, status_code, timed_out, error_msg, created)
values (9004, null, true, 'Timeout of 5000 ms reached', now());
select throws_ok($$ select ops.check_dispatcher_response() $$, 'P0001', 'dispatcher answered Timeout of 5000 ms reached',
  'a timeout fails it');

insert into net._http_response (id, status_code, created) values (9005, 204, now());
select lives_ok($$ select ops.check_dispatcher_response() $$, 'the next 2xx clears it');

insert into net._http_response (id, status_code, created) values (9006, 401, now() - interval '11 minutes');
select lives_ok($$ select ops.check_dispatcher_response() $$, 'a failure older than 10 minutes is ignored');

select is((select count(*)::int from cron.job where jobname = 'check-dispatcher' and active), 1,
  'the check is scheduled');

select tests.act_as('owner');
select throws_ok($$ select ops.check_dispatcher_response() $$, '42501', null,
  'a signed-in owner cannot run it');

select * from finish();
rollback;
