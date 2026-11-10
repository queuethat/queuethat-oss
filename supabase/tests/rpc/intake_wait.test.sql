-- 2A-GST10 (#131): api.get_location_wait lists a queue's guest-visible intake fields, in order.
begin;
\ir ../helpers/_setup.psql
select plan(6);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_i'), tests.id('org_a'), tests.id('loc_a'), 'Intake', 'I'),
  (tests.new_id('queue_n'), tests.id('org_a'), tests.id('loc_a'), 'Plain', 'P');
insert into app.intake_fields (org_id, location_id, queue_id, key, label, help, type, options, required, visibility, position, active) values
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_i'), 'reason', 'Reason for visit', 'A few words', 'text', null, true, 'guest', 2, true),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_i'), 'size', 'Size', null, 'select', '["S","M"]', false, 'guest', 1, true),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_i'), 'internal', 'Staff note', null, 'text', null, false, 'staff_only', 0, true),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_i'), 'retired', 'Retired', null, 'text', null, false, 'guest', 3, false);

select tests.as_anon();
select is((select jsonb_array_length(intake_fields) from api.get_location_wait('test-location-a')
           where queue_id = tests.id('queue_i')), 2, 'a guest sees only the active guest-visible fields');
select is((select jsonb_agg(f ->> 'key') from api.get_location_wait('test-location-a') w,
           jsonb_array_elements(w.intake_fields) f where w.queue_id = tests.id('queue_i')),
  '["size", "reason"]'::jsonb, 'in position order');
select is((select (intake_fields -> 1 ->> 'required')::boolean from api.get_location_wait('test-location-a')
           where queue_id = tests.id('queue_i')), true, 'with the required flag');
select is((select intake_fields from api.get_location_wait('test-location-a')
           where queue_id = tests.id('queue_n')), '[]'::jsonb, 'a queue without fields gets an empty list');
select ok((select intake_fields::text !~ '(internal|Staff note|retired|visibility|org_id)'
           from api.get_location_wait('test-location-a') where queue_id = tests.id('queue_i')),
  'nothing staff-only, inactive or internal is in the answer');

-- Cross-tenant: another org's slug never returns this org's fields.
select is_empty($$ select 1 from api.get_location_wait('test-location-b') w, jsonb_array_elements(w.intake_fields) f
                   where f ->> 'key' in ('reason', 'size') $$, 'another location''s page never lists these fields');

select * from finish();
rollback;
