-- 2P-APT12 (#168): each booked appointment has one expected visit on its service day.
begin;
\ir ../helpers/_setup.psql
select plan(22);
select tests.create_world();
-- Slots here sit minutes ahead of now and must stay on the location's service day (it rolls over at
-- 04:00 local), so put the location's clock at noon whatever time the test runs.
update app.locations set tz = case
  when extract(hour from now() at time zone 'UTC') = 12 then 'Etc/UTC'
  else 'Etc/GMT' || case when extract(hour from now() at time zone 'UTC') < 12 then '-' else '+' end
       || abs(12 - extract(hour from now() at time zone 'UTC'))::int
  end
 where id = tests.id('loc_a');
-- Payment policies are covered by payments/require_card.test.sql; this suite books without a card step.
update app.payment_policies set mode = 'none';

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

-- AC1: three for tomorrow stay appointments until the day begins; the tick then makes exactly three visits
create temp table t3 as select pg_temp.appt('t' || i, now() + interval '1 day' + i * interval '1 minute') as id from generate_series(0, 2) i;
select is((select count(*)::int from app.visits where source = 'appointment' and org_id = tests.id('org_a')), 0, 'a booking for another day has no visit yet');
select is(private.materialize_due(now() + interval '1 day'), 3, 'AC1: the tick at the day boundary creates three visits');
select is(private.materialize_due(now() + interval '1 day'), 0, 'AC1: running it again creates none');
select is((select count(*)::int from app.visits where source = 'appointment' and org_id = tests.id('org_a') and status = 'expected'), 3, 'AC1: exactly three expected visits');
select is((select count(*)::int from app.appointments a join app.visits v on v.id = a.visit_id
           where a.id in (select id from t3) and v.scheduled_at = a.starts_at and v.org_id = a.org_id), 3, 'each is linked and scheduled at the start');

-- a booking for today is materialized at once
select pg_temp.appt('today1', now() + interval '2 minutes');
select is((select v.status::text from app.appointments a join app.visits v on v.id = a.visit_id where a.guest_name = 'today1'), 'expected',
  'a booking for today gets its visit immediately');
select is((select v.guest_token_hash = a.guest_token_hash from app.appointments a join app.visits v on v.id = a.visit_id where a.guest_name = 'today1'), true,
  'the appointment link is the visit link');

-- AC2: staff check-in moves the appointment to checked_in
select tests.act_as('staff');
select api.transition_visit((select visit_id from app.appointments where guest_name = 'today1'), 'check_in',
  (select v.version from app.appointments a join app.visits v on v.id = a.visit_id where a.guest_name = 'today1'), gen_random_uuid());
select tests.as_postgres();
select is((select status::text from app.appointments where guest_name = 'today1'), 'checked_in', 'AC2: check-in makes the appointment checked_in');

-- AC3: no show after the grace window, actor system
select pg_temp.appt('late1', now() + interval '3 minutes');
select is(private.expire_unarrived(now() + interval '1 hour'), 1, 'AC3: one unarrived guest expires');
select is((select v.status::text from app.appointments a join app.visits v on v.id = a.visit_id where a.guest_name = 'late1'), 'no_show', 'AC3: the visit is no_show');
select is((select e.actor_kind::text from app.visit_events e join app.appointments a on a.visit_id = e.visit_id
           where a.guest_name = 'late1' and e.type = 'no_show'), 'system', 'AC3: by the system');
select is((select status::text from app.appointments where guest_name = 'late1'), 'no_show', 'the appointment follows');
select is(private.expire_unarrived(now() + interval '1 hour'), 0, 'expiring twice changes nothing');

-- AC4: cancelling the appointment cancels its expected visit
select tests.as_anon();
select api.guest_cancel_appointment('tok-t0', gen_random_uuid());
select tests.as_postgres();
select is((select v.status::text from app.appointments a join app.visits v on v.id = a.visit_id where a.guest_name = 't0'), 'cancelled', 'AC4: the visit is cancelled');
select ok(exists (select 1 from app.visit_events e join app.appointments a on a.visit_id = e.visit_id
                  where a.guest_name = 't0' and e.type = 'cancel' and e.actor_kind = 'guest'), 'AC4: with an event');
select is((select count(*)::int from app.notifications n join app.appointments a on a.visit_id = n.visit_id where a.guest_name = 't0'), 0, 'AC4: nothing was queued for it');

-- staff cancelling the expected visit cancels the booking too
select tests.act_as('staff');
select api.transition_visit((select visit_id from app.appointments where guest_name = 't1'), 'cancel',
  (select v.version from app.appointments a join app.visits v on v.id = a.visit_id where a.guest_name = 't1'), gen_random_uuid());
select tests.as_postgres();
select is((select status::text from app.appointments where guest_name = 't1'), 'cancelled', 'cancelling the visit cancels the appointment');

-- reschedule: same day moves scheduled_at, another day cancels and unlinks
select pg_temp.appt('move1', now() + interval '4 minutes');
select private.set_actor('guest', null, 'reschedule', 'guest');
update app.appointments set starts_at = starts_at + interval '5 minutes', ends_at = ends_at + interval '5 minutes' where guest_name = 'move1';
select is((select (v.scheduled_at = a.starts_at) from app.appointments a join app.visits v on v.id = a.visit_id where a.guest_name = 'move1'), true,
  'same-day reschedule moves scheduled_at');
select ok(exists (select 1 from app.visit_events e join app.appointments a on a.visit_id = e.visit_id where a.guest_name = 'move1' and e.type = 'rescheduled'),
  'with a rescheduled event');
create temp table old_visit as select visit_id from app.appointments where guest_name = 'move1';
update app.appointments set starts_at = now() + interval '3 days', ends_at = now() + interval '3 days 20 minutes',
  local_date = (now() + interval '3 days')::date where guest_name = 'move1';
select is((select status::text from app.visits where id = (select visit_id from old_visit)), 'cancelled', 'another-day reschedule cancels the old visit');
select is((select visit_id from app.appointments where guest_name = 'move1'), null, 'and the appointment has no visit until its day');

-- AC5: cross-tenant
select tests.act_as('other_owner');
select is((select count(*)::int from app.visits where source = 'appointment' and org_id = tests.id('org_a')), 0, 'AC5: org B sees none of org A''s expected visits');
select tests.as_postgres();

select * from finish();
rollback;
