-- 3-RPT1 (#368): scheduled email reports.
begin;
\ir ../helpers/_setup.psql
select plan(11);
select tests.create_world();

-- Europe/Berlin location; a weekly Monday 08:00 schedule for the owner and the admin.
update app.locations set tz = 'Europe/Berlin' where id = tests.id('loc_a');
insert into app.report_schedules (id, org_id, location_id, frequency, weekday, send_at_local, recipients)
values (tests.new_id('sched_w'), tests.id('org_a'), tests.id('loc_a'), 'weekly', 1, '08:00',
        array[tests.id('owner'), tests.id('admin')]);
insert into app.report_schedules (id, org_id, location_id, frequency, send_at_local, recipients, enabled)
values (tests.new_id('sched_off'), tests.id('org_a'), tests.id('loc_a'), 'daily', '08:00', array[tests.id('owner')], false);

create function tests.queued() returns int language sql as
  $$ select count(*)::int from app.notifications where template_key = 'report_summary' $$;

-- 2026-03-30 is the Monday after Berlin's spring-forward (Sunday 03-29, 02:00 -> 03:00).
-- 06:00 UTC on 03-23 is 07:00 local (CET): not due yet. 07:00 UTC is 08:00 CET.
select is(ops.enqueue_due_reports('2026-03-23 06:00:00+00'), 0, 'before the local send time nothing is queued');
select is(ops.enqueue_due_reports('2026-03-23 07:00:00+00'), 2, 'AC1: Monday 08:00 CET queues one email per recipient');
select is(ops.enqueue_due_reports('2026-03-23 07:15:00+00'), 0, 'a later tick in the same hour queues nothing more');
select is(ops.enqueue_due_reports('2026-03-24 07:00:00+00'), 0, 'Tuesday: a weekly schedule is not due');
-- After the DST change the same wall-clock time is one hour earlier in UTC.
select is(ops.enqueue_due_reports('2026-03-30 07:00:00+00'), 0, 'AC1: 07:00 UTC is 09:00 CEST, outside the hour');
select is(ops.enqueue_due_reports('2026-03-30 06:00:00+00'), 2, 'AC1: Monday 08:00 CEST queues again, one report per week');
select is(tests.queued(), 4, 'two weeks, two recipients, nothing else (the disabled schedule queued none)');

-- AC2: a recipient who left the org gets nothing.
delete from app.memberships where org_id = tests.id('org_a') and user_id = tests.id('admin');
select is(ops.enqueue_due_reports('2026-04-06 06:00:00+00'), 1, 'AC2: a removed member is skipped');

-- AC3: the vars hold numbers only.
select is((select count(*)::int from app.notifications n, jsonb_object_keys(n.vars) k
           where n.template_key = 'report_summary' and k not in
             ('visits', 'served', 'avg_wait_min', 'no_show_pct', 'busiest_hour', 'eta_miss_min', 'org', 'location', 'frequency', 'period')),
  0, 'AC3: report vars carry aggregates and names of the org and location only');

-- A recipient must be a member of the org, validated on write.
select throws_ok($$ insert into app.report_schedules (org_id, location_id, frequency, send_at_local, recipients)
                    values (tests.id('org_a'), tests.id('loc_a'), 'daily', '09:00', array[gen_random_uuid()]) $$,
  'P0001', 'invalid_recipient', 'a non-member cannot be a recipient');

-- AC4: org B's admin sees no org A schedules.
select tests.as_user(tests.id('other_owner'));
select is((select count(*)::int from app.report_schedules), 0, 'AC4: another org reads zero schedules');

select * from finish();
rollback;
