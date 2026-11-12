-- F3 (#1279): bookings carry answers against a form version; check-in carries them to the visit by reference.
begin;
\ir ../helpers/_setup.psql
select plan(27);
select tests.create_world();
-- Keep slots on today's service day whatever time the test runs (see appointments/materialize.test.sql).
update app.locations set tz = case
  when extract(hour from now() at time zone 'UTC') = 12 then 'Etc/UTC'
  else 'Etc/GMT' || case when extract(hour from now() at time zone 'UTC') < 12 then '-' else '+' end
       || abs(12 - extract(hour from now() at time zone 'UTC'))::int
  end
 where id = tests.id('loc_a');
update app.payment_policies set mode = 'none';
select tests.new_id(k) from unnest(array['f_bk','v_bk']) k;

create function tests.error_detail(p_sql text) returns text
language plpgsql as $$
declare d text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics d = pg_exception_detail;
  return d;
end $$;
grant execute on function tests.error_detail(text) to anon, authenticated;

create function pg_temp.appt(p_name text, p_at timestamptz, p_org text default 'org_a') returns uuid language plpgsql as $$
declare id uuid := gen_random_uuid();
begin
  perform private.set_actor('system', null, 'test', 'test');
  insert into app.appointments (id, org_id, location_id, service_id, queue_id, starts_at, ends_at, local_date,
                                guest_name, guest_email, source, idempotency_key, guest_token_hash)
  values (id, tests.id(p_org), tests.id('loc_a'), tests.id('service_a'), tests.id('queue_a'), p_at,
          p_at + interval '20 minutes', (p_at at time zone (select l.tz from app.locations l where l.id = tests.id('loc_a')))::date, p_name, p_name || '@example.com',
          'guest', gen_random_uuid(), private.token_hash('tok-' || p_name));
  return id;
end $$;

-- A booking-only form on the service: one required guest field and one staff-only field.
insert into app.forms (id, org_id, location_id, name, status) values (tests.id('f_bk'), tests.id('org_a'), tests.id('loc_a'), 'Booking intake', 'published');
insert into app.form_versions (id, org_id, location_id, form_id, version, fields, published_at)
values (tests.id('v_bk'), tests.id('org_a'), tests.id('loc_a'), tests.id('f_bk'), 1,
  '[{"key":"allergy","label":"Allergies","type":"text","required":true,"visibility":"guest","position":1},
    {"key":"triage","label":"Triage","type":"text","visibility":"staff_only","position":2}]', now());
insert into app.form_targets (org_id, location_id, form_id, service_id, channel)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('f_bk'), tests.id('service_a'), 'booking');

select is(private.resolve_form_for(tests.id('queue_a'), tests.id('service_a'), 'booking'), tests.id('v_bk'), 'a booking-channel target is resolved for bookings');
select isnt(private.resolve_form_for(tests.id('queue_a'), tests.id('service_a'), 'walk_in'), tests.id('v_bk'), 'and never for a walk-in');
select is(private.resolve_form(tests.id('queue_a'), tests.id('service_a')), private.resolve_form_for(tests.id('queue_a'), tests.id('service_a'), 'walk_in'), 'resolve_form is the walk-in case');

select tests.as_anon();
select is(api.get_join_form(tests.id('queue_a'), tests.id('service_a'), 'booking') -> 'form_version_id', to_jsonb(tests.id('v_bk')), 'get_join_form serves the booking form');
select is(jsonb_array_length(api.get_join_form(tests.id('queue_a'), tests.id('service_a'), 'booking') -> 'fields'), 1, 'staff-only fields stay out of it');
select ok(api.get_join_form(tests.id('queue_a'), tests.id('service_a')) ->> 'form_version_id' is distinct from tests.id('v_bk')::text, 'the default channel is still walk_in');
select throws_ok($$ select api.get_join_form(tests.id('queue_a'), null, 'sms') $$, 'P0001', 'invalid_input', 'an unknown channel is refused');

-- Answers by token.
select tests.as_postgres();
create temp table ap as select pg_temp.appt('later', now() + interval '1 day') id;
select tests.as_anon();
select throws_ok($$ select api.set_booking_answers('nope', '{}') $$, 'P0001', 'not_found', 'an unknown token is not_found');
select is(tests.error_detail($$ select api.set_booking_answers('tok-later', '{}') $$), 'allergy', 'a required guest field is enforced');
select is(tests.error_detail($$ select api.set_booking_answers('tok-later', '{"allergy": "nuts", "triage": "x"}') $$), 'triage', 'a guest cannot answer a staff-only field');
select is(tests.error_detail($$ select api.set_booking_answers('tok-later', '{"allergy": "4111 1111 1111 1111"}') $$), 'allergy', 'card numbers are refused (C5)');
select is(api.set_booking_answers('tok-later', '{"allergy": "nuts"}'), jsonb_build_object('form_version_id', tests.id('v_bk')), 'valid answers are recorded and the version returned');
select lives_ok($$ select api.set_booking_answers('tok-later', '{"allergy": "none"}') $$, 'a repeat replaces the answers');
select tests.as_postgres();
select is((select count(*)::int from app.form_responses where appointment_id = (select id from ap)), 1, 'one response per booking and version');
select is((select answers from app.form_responses where appointment_id = (select id from ap)), '{"allergy": "none"}'::jsonb, 'holding the latest answers');
select ok((select visit_id is null from app.form_responses where appointment_id = (select id from ap)), 'a future booking has no visit to carry them to');

-- A newer form version does not move a booking that recorded v1.
insert into app.form_versions (org_id, location_id, form_id, version, fields, published_at)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('f_bk'), 2, '[{"key":"other","label":"Other","type":"text","position":1}]', now());
select tests.as_anon();
select lives_ok($$ select api.set_booking_answers('tok-later', '{"allergy": "pollen"}') $$, 'the recorded version still validates the booking');

-- The visit appears at the day boundary: the same response row points at it, nothing is asked or copied.
select tests.as_postgres();
select private.materialize_due(now() + interval '1 day');
select is((select r.visit_id from app.form_responses r where r.appointment_id = (select id from ap)), (select visit_id from app.appointments where id = (select id from ap)),
  'F3: materialization points the response at the visit');
select is((select count(*)::int from app.form_responses where visit_id = (select visit_id from app.appointments where id = (select id from ap))), 1, 'by reference: still one row');
select is((select answers from app.visit_answers where visit_id = (select visit_id from app.appointments where id = (select id from ap))), '{"allergy": "pollen"}'::jsonb,
  'the staff console''s answers row is mirrored');

-- A booking for today has its visit at once (and takes the newer v2 form); answers given afterwards are carried straight away.
create temp table ap2 as select pg_temp.appt('today', now() + interval '2 minutes') id;
select tests.as_anon();
select lives_ok($$ select api.set_booking_answers('tok-today', '{"other": "latex"}') $$, 'answers after the visit exists');
select tests.as_postgres();
select is((select r.visit_id from app.form_responses r where r.appointment_id = (select id from ap2)), (select visit_id from app.appointments where id = (select id from ap2)),
  'F3: carried to the existing visit');

-- A cancelled booking takes no more answers.
select pg_temp.appt('gone', now() + interval '3 days');
update app.appointments set status = 'cancelled' where guest_name = 'gone';
select tests.as_anon();
select throws_ok($$ select api.set_booking_answers('tok-gone', '{"allergy": "x"}') $$, 'P0001', 'too_late_to_change', 'a cancelled booking is too late');

-- Erasure and cross-tenant.
select tests.act_as('other_owner');
select throws_ok($$ select count(*) from app.form_responses $$, '42501', null, 'cross-tenant: another org''s owner cannot read responses directly (F7b)');
select tests.as_postgres();
select private.anonymize_appointments(tests.id('org_a'), array[(select id from ap)]);
select is((select count(*)::int from app.form_responses where appointment_id = (select id from ap)) +
          (select count(*)::int from app.visit_answers where visit_id = (select visit_id from app.appointments where id = (select id from ap))), 0,
  'F3: anonymizing the booking erases its answers and the mirror');
select tests.as_anon();
select throws_ok($$ select api.set_booking_answers('tok-later', '{"other": "x"}') $$, 'P0001', 'not_found', 'F3: an erased booking takes no new answers');
select tests.as_postgres();
select private.anonymize_visits(tests.id('org_a'), array[(select visit_id from app.appointments where id = (select id from ap2))]);
select is((select count(*)::int from app.form_responses where appointment_id = (select id from ap2)), 0, 'F3: anonymizing the visit erases a carried response too');

select * from finish();
rollback;
