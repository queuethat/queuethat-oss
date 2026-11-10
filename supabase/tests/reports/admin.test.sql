-- 3-RPT2 (#369): next send time, listing and preview for the report schedules page.
begin;
\ir ../helpers/_setup.psql
select plan(10);
select tests.create_world();

update app.locations set tz = 'Europe/Berlin' where id = tests.id('loc_a');
insert into app.report_schedules (id, org_id, location_id, frequency, weekday, send_at_local, recipients)
values (tests.new_id('sched_w'), tests.id('org_a'), tests.id('loc_a'), 'weekly', 1, '08:00', array[tests.id('owner')]);

-- AC1: the next send time is wall-clock in the location's zone, across a DST change.
select is(private.next_report_at('weekly', 1::smallint, '08:00', 'Europe/Berlin', '2026-03-26 12:00:00+00'),
  '2026-03-30 06:00:00+00'::timestamptz, 'Thursday before the change: Monday 08:00 CEST is 06:00 UTC');
select is(private.next_report_at('weekly', 1::smallint, '08:00', 'Europe/Berlin', '2026-03-16 12:00:00+00'),
  '2026-03-23 07:00:00+00'::timestamptz, 'the week before: Monday 08:00 CET is 07:00 UTC');
select is(private.next_report_at('daily', null, '08:00', 'Europe/Berlin', '2026-03-23 07:00:00+00'),
  '2026-03-24 07:00:00+00'::timestamptz, 'daily: strictly after now, so the same instant moves to tomorrow');

select tests.as_postgres();
select tests.as_user(tests.id('owner'));
select results_eq($$ select location_name, frequency, enabled, next_send_at is not null from api.list_report_schedules(tests.id('org_a')) where id = tests.id('sched_w') $$,
  $$ values ('Location A', 'weekly', true, true) $$, 'AC1: an owner lists the schedule with its next send time');

select tests.as_postgres();
select tests.as_user(tests.id('manager'));
select is((select count(*)::int from api.list_report_schedules(tests.id('org_a'))), 0, 'a manager sees no schedules');
select tests.as_postgres();
select tests.as_user(tests.id('other_owner'));
select is((select count(*)::int from api.list_report_schedules(tests.id('org_a'))), 0, 'another org sees none either');

-- AC2: the preview goes to the caller only.
select tests.as_postgres();
select tests.as_user(tests.id('owner'));
select lives_ok($$ select api.send_report_preview(tests.id('sched_w')) $$, 'an owner can preview');
select tests.as_postgres();
select results_eq($$ select recipient_ref, template_key from app.notifications where dedupe_key like 'report:preview:%' $$,
  $$ values (tests.id('owner'), 'report_summary') $$, 'AC2: exactly one email, to the owner, not the other recipients');

select tests.as_postgres();
select tests.as_user(tests.id('manager'));
select throws_ok($$ select api.send_report_preview(tests.id('sched_w')) $$, 'P0001', 'not_found',
  'a manager cannot preview');
select tests.as_postgres();
select tests.as_user(tests.id('owner'));
select api.send_report_preview(tests.id('sched_w'));
select api.send_report_preview(tests.id('sched_w'));
select api.send_report_preview(tests.id('sched_w'));
select api.send_report_preview(tests.id('sched_w'));
select throws_ok($$ select api.send_report_preview(tests.id('sched_w')) $$, 'P0001', 'rate_limited',
  'the sixth preview within an hour is refused');

select * from finish();
rollback;
