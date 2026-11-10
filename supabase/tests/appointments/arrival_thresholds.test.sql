-- 2P-APT14 (#170): staff_visits carries the early/late thresholds from the queue's knobs.
begin;
\ir ../helpers/_setup.psql
select plan(3);
select tests.create_world();
select tests.make_expected_visit('exp', 'queue_a', '2026-12-01 10:00+00', 'Eve');
update app.queues set early_checkin_minutes = 20, late_tolerance_minutes = 5 where id = tests.id('queue_a');
select tests.act_as('staff');
select is((select arrival_early_until from app.staff_visits where id = tests.id('exp')), '2026-12-01 09:40+00'::timestamptz, 'early until start minus the early window');
select is((select arrival_late_after from app.staff_visits where id = tests.id('exp')), '2026-12-01 10:05+00'::timestamptz, 'late after start plus the tolerance');
select is((select allowed_actions from app.staff_visits where id = tests.id('exp')) @> array['check_in']::api.visit_action[], true, 'the database offers check_in');
select * from finish();
rollback;
