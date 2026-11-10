-- 2P-PRV1 (#188): the daily retention job.
begin;
\ir ../helpers/_setup.psql
select plan(17);
select tests.create_world();
-- The default is now 365 days (C3); these cases are written for a 30-day business.
update app.organizations set retention_days = 30 where id in (tests.id('org_a'), tests.id('org_b'));

delete from app.business_hours where location_id = tests.id('loc_a');
select tests.as_postgres();
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Other org', 'B');
select private.set_actor('system', null);

/** An org A guest with a phone, a served visit that ended p_days_ago days ago, and an old guest row. */
create function tests.old_visit(p_name text, p_days int, p_org text default 'org_a', p_queue text default 'queue_a')
returns uuid language plpgsql as $$
declare
  vid uuid := tests.new_visit(p_name, p_queue);
  gid uuid := gen_random_uuid();
begin
  insert into app.guests (id, org_id, first_name, created_at)
  values (gid, tests.id(p_org), p_name, now() - make_interval(days => p_days + 1));
  insert into app.guest_contacts (org_id, guest_id, channel, value, created_source)
  values (tests.id(p_org), gid, 'phone', '+1415555' || lpad((random() * 9999)::int::text, 4, '0'), 'staff');
  perform private.set_actor('system', null);
  update app.visits set guest_id = gid, guest_phone_e164 = '+14155550000', guest_email = p_name || '@example.com',
    contact_id = (select id from app.guest_contacts where guest_id = gid)
  where id = vid;
  perform private.set_actor('staff', null, 'call'); update app.visits set status = 'called' where id = vid;
  perform private.set_actor('staff', null, 'start'); update app.visits set status = 'serving' where id = vid;
  perform private.set_actor('staff', null, 'complete');
  update app.visits set status = 'served', finished_at = now() - make_interval(days => p_days) where id = vid;
  return vid;
end $$;

select tests.old_visit('old_a', 31);
select tests.old_visit('new_a', 29);
select tests.old_visit('old_b', 31, 'org_b', 'queue_b');

create temp table stats_before as
  select status, party_size, joined_at, finished_at, service_id from app.visits where id = tests.id('old_a');

select is(ops.retention_tick() >= 1, true, 'the tick anonymizes eligible visits');
select is((select (guest_name is null and guest_email is null and guest_phone_e164 is null and guest_id is null
                   and contact_id is null and anonymized_at is not null) from app.visits where id = tests.id('old_a')), true,
  'AC1: name, contacts and links are gone from a 31-day-old visit');
select is((select count(*) from app.visits where id = tests.id('old_a')), 1::bigint, 'AC1: the visit row remains');
select is((select row(status, party_size, joined_at, finished_at, service_id) from app.visits where id = tests.id('old_a')),
  (select row(status, party_size, joined_at, finished_at, service_id) from stats_before),
  'AC3: analytics fields are untouched');
select is((select count(*) from app.visit_events where visit_id = tests.id('old_a') and type = 'anonymized'), 1::bigint,
  'AC1: one anonymized event exists');
select is((select count(*) from app.visit_events where visit_id = tests.id('old_a') and payload::text ~* '@|\+1'), 0::bigint,
  'the event payloads hold no contact data');
select is((select guest_phone_e164 from app.visits where id = tests.id('new_a')), '+14155550000', 'AC2: a 29-day-old visit is untouched');
select is((select count(*) from app.guests where first_name = 'old_a'), 0::bigint, 'the old guest and its contacts are deleted');
select is((select count(*) from app.guests where first_name = 'new_a'), 1::bigint, 'a guest with a live visit stays');

-- Idempotent, and each run is recorded.
select is(ops.retention_tick(), 0, 'AC4: a second run changes nothing');
select is((select count(*) from app.retention_runs where org_id = tests.id('org_a')), 3::bigint,
  'AC4: both runs are recorded (plus the fixture row)');

-- Per-org period.
update app.organizations set retention_days = 1 where id = tests.id('org_a');
select tests.old_visit('mid_a', 5);
select tests.old_visit('mid_b', 5, 'org_b', 'queue_b');
select ops.retention_tick();
select is((select guest_phone_e164 is null from app.visits where id = tests.id('mid_a')), true, 'AC5: org A (1 day) anonymizes a 5-day-old visit');
select is((select guest_phone_e164 from app.visits where id = tests.id('mid_b')), '+14155550000', 'AC5: org B (30 days) keeps data of the same age');
select is((select visits_anonymized from app.retention_runs where org_id = tests.id('org_a') and id < 900000000 order by id desc limit 1), 2,
  'the run row counts what it changed');

-- Consent evidence survives with the link nulled.
select is((select count(*) from app.consents where id = tests.id('consent_a')), 1::bigint, 'consent rows are kept');

-- AC6: RLS.
select tests.act_as('other_owner');
select is((select count(*) from app.retention_runs where org_id = tests.id('org_a')), 0::bigint, 'AC6: org B sees no org A runs');
select tests.act_as('owner');
select cmp_ok((select count(*) from app.retention_runs), '>=', 1::bigint, 'org A owner reads its runs');

select * from finish();
rollback;
