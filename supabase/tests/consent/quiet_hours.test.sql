-- 3-CG9 (#334): non-urgent messages wait for the location's send window; DST-correct; called is exempt.
begin;
\ir ../helpers/_setup.psql
select plan(33);
select tests.create_world();

create function tests.window_at(p_tz text, p_local text) returns timestamptz language sql as $$
  select private.next_send_window(tests.id('loc_a'), (p_local::timestamp) at time zone p_tz)
$$;
update app.locations set tz = 'America/New_York' where id = tests.id('loc_a');

-- AC1: the eve of 2026 DST start (March 8), 21:30 New York -> 08:00 EDT (UTC-4) the next morning.
select is(tests.window_at('America/New_York', '2026-03-07 21:30'), '2026-03-08 12:00:00+00'::timestamptz,
  'AC1: 21:30 on the eve of DST start opens at 08:00 EDT = 12:00Z');
select is(tests.window_at('America/New_York', '2026-03-06 21:30'), '2026-03-07 13:00:00+00'::timestamptz, 'a normal winter night opens at 08:00 EST = 13:00Z');
select is(tests.window_at('America/New_York', '2026-07-01 12:00'), '2026-07-01 12:00-04'::timestamptz, 'inside the window it is unchanged');
select is(tests.window_at('America/New_York', '2026-07-01 03:00'), '2026-07-01 12:00:00+00'::timestamptz, 'before 08:00 it opens the same morning');
select is(tests.window_at('America/New_York', '2026-07-01 20:00'), '2026-07-02 12:00:00+00'::timestamptz, '20:00 is already outside');
-- AC4: Europe/Berlin around the October DST change (Oct 25 2026, CEST -> CET).
update app.locations set tz = 'Europe/Berlin' where id = tests.id('loc_a');
select is(tests.window_at('Europe/Berlin', '2026-10-24 21:00'), '2026-10-25 07:00:00+00'::timestamptz, 'AC4: Saturday night opens 08:00 CET (the clocks went back at 03:00) = 07:00Z');
select is(tests.window_at('Europe/Berlin', '2026-10-25 21:00'), '2026-10-26 07:00:00+00'::timestamptz, 'AC4: Sunday night opens 08:00 CET = 07:00Z');
-- A narrower window.
update app.locations set send_window_start = '09:30', send_window_end = '18:00' where id = tests.id('loc_a');
select is(tests.window_at('Europe/Berlin', '2026-10-26 18:30'), '2026-10-27 08:30:00+00'::timestamptz, 'a narrower window opens at its own start');
select throws_ok($$ update app.locations set send_window_start = '07:00' where id = tests.id('loc_a') $$, '23514', null, 'a window cannot start before 08:00');
select lives_ok($$ update app.locations set send_window_start = '08:00', send_window_end = '21:00' where id = tests.id('loc_a') $$, 'Q1: a window may run until 21:00');
select throws_ok($$ update app.locations set send_window_end = '21:01' where id = tests.id('loc_a') $$, '23514', 'send_window_out_of_bounds', 'nor end after 21:00');
select throws_ok($$ update app.locations set send_window_start = '07:59', send_window_end = '12:00' where id = tests.id('loc_a') $$, '23514', 'send_window_out_of_bounds', 'nor start before 08:00, even with a narrow end');
select throws_ok($$ update app.locations set send_window_start = '12:00', send_window_end = '12:00' where id = tests.id('loc_a') $$, '23514', null, 'an empty window is refused');
select lives_ok($$ update app.locations set send_window_start = '09:30', send_window_end = '18:00' where id = tests.id('loc_a') $$, 'a narrower window is fine');
update private.send_window_bounds set latest = '22:00';
select lives_ok($$ update app.locations set send_window_end = '22:00' where id = tests.id('loc_a') $$, 'counsel can change the envelope with one row, no migration');
update private.send_window_bounds set latest = '21:00';
select throws_ok($$ insert into app.locations (org_id, name, tz, send_window_end) values (tests.id('org_a'), 'late', 'UTC', '23:00') $$, '23514', 'send_window_out_of_bounds', 'a new location cannot start outside the envelope');
update app.locations set send_window_start = '08:00', send_window_end = '21:00' where id = tests.id('loc_a');
select is(tests.window_at('Europe/Berlin', '2026-10-26 20:30'), '2026-10-26 19:30:00+00'::timestamptz, 'with the 21:00 envelope 20:30 is still inside');
select is(tests.window_at('Europe/Berlin', '2026-10-26 21:00'), '2026-10-27 07:00:00+00'::timestamptz, 'and 21:00 is outside');
select is(private.next_send_window(gen_random_uuid(), now()), null, 'an unknown location has no window');

-- The claim defers non-urgent rows outside the window and leaves called alone (AC2).
update app.locations set send_window_start = '08:00', send_window_end = '20:00',
  tz = (select name from pg_timezone_names where extract(hour from now() at time zone name) = 23 and name !~ '^(posix|Etc|SystemV)' limit 1)
where id = tests.id('loc_a');
insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key) values
  (tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('contact_a'), 'almost_up', 1, 'q1'),
  (tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('contact_a'), 'called', 1, 'q2');
select count(*) from api.claim_outbox(200, 60);
select results_eq($$ select dedupe_key, status::text, next_attempt_at > now() + interval '8 hours', quiet_hours_deferred from app.notifications where dedupe_key in ('q1', 'q2') order by 1 $$,
  $$ values ('q1', 'queued', true, true), ('q2', 'claimed', false, false) $$, 'AC2: almost_up waits for 08:00; called is claimed at 23:00');
-- #1203: the HELP reply, the one-time code and replies to inbound commands are never held.
insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key) values
  (tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('contact_a'), 'help', 1, 'u1'),
  (tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('contact_a'), 'reply_verify', 1, 'u2'),
  (tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('contact_a'), 'reply_left', 1, 'u3'),
  (tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('contact_a'), 'position_changed', 1, 'u4');
select count(*) from api.claim_outbox(200, 60);
select results_eq($$ select dedupe_key, status::text, quiet_hours_deferred from app.notifications where dedupe_key like 'u_' order by 1 $$,
  $$ values ('u1', 'claimed', false), ('u2', 'claimed', false), ('u3', 'claimed', false), ('u4', 'queued', true) $$,
  '#1203: help, reply_verify and reply_* are claimed at 23:00; other texts still wait');
-- C5 (#1231): one predicate owns the rule. At 23:00 local, one assertion per exemption and per held key.
select is(private.send_window_open(tests.id('loc_a'), 'called', 'sms'), true, 'C5: called is exempt at 23:00');
select is(private.send_window_open(tests.id('loc_a'), 'help', 'sms'), true, 'C5: help is exempt');
select is(private.send_window_open(tests.id('loc_a'), 'reply_verify', 'sms'), true, 'C5: reply_verify is exempt');
select is(private.send_window_open(tests.id('loc_a'), 'reply_join', 'sms'), true, 'C5: reply_* is exempt');
select is(private.send_window_open(tests.id('loc_a'), 'almost_up', 'push'), true, 'C5: web push is exempt');
select is(private.send_window_open(null, 'almost_up', 'email'), true, 'C5: account mail (no location) is exempt');
select is(private.send_window_open(tests.id('loc_a'), 'almost_up', 'sms'), false, 'C5: almost_up is held at 23:00');
select is(private.send_window_open(tests.id('loc_a'), 'almost_up', 'sms',
  (current_date + time '12:00') at time zone (select tz from app.locations where id = tests.id('loc_a'))), true, 'C5: almost_up is open at noon local');
-- A row queued after the deferral pass is still not claimed: the claim applies the window itself.
insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
  values (tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('contact_a'), 'almost_up', 1, 'q3');
update app.notifications set next_attempt_at = now() - interval '1 minute' where dedupe_key = 'q3';
select is((select count(*) from api.claim_outbox(200, 60) where template_key = 'almost_up'), 0::bigint, 'C5: a closed window claims no non-urgent row');
select is((select status::text from app.notifications where dedupe_key = 'q3'), 'queued', 'C5: the row waits, unclaimed');
-- AC3: once the visit is no longer waiting, the deferred row is dropped when the window opens (outbox_still_relevant).
select is(api.outbox_still_relevant((select id from app.notifications where dedupe_key = 'q1')), true, 'the deferred almost_up is relevant while the guest waits');
select private.set_actor('guest', null, 'cancel');
update app.visits set status = 'cancelled', finished_at = now() where id = tests.id('visit_a');
select is(api.outbox_still_relevant((select id from app.notifications where dedupe_key = 'q1')), false,
  'AC3: once the visit is over, the deferred row is dropped when the window opens');

select * from finish();
rollback;
