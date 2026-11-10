-- 2B-Q2 (#227): priority rules classify a join by source or intake answer.
begin;
\ir ../helpers/_setup.psql
select plan(13);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_pr'), tests.id('org_a'), tests.id('loc_a'), 'Rules', 'R');
insert into app.intake_fields (id, org_id, location_id, queue_id, key, label, type, options)
values (tests.new_id('f_help'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_pr'), 'help', 'Help', 'select', '["none","access"]');
insert into app.priority_classes (id, org_id, location_id, name, offset_minutes) values
  (tests.new_id('c_appt'), tests.id('org_a'), tests.id('loc_a'), 'Appointment holder', 0),
  (tests.new_id('c_hi'), tests.id('org_a'), tests.id('loc_a'), 'High', 30),
  (tests.new_id('c_lo'), tests.id('org_a'), tests.id('loc_a'), 'Low', 5),
  (tests.new_id('c_b'), tests.id('org_b'), tests.id('loc_b'), 'Other org', 5);

create function tests.joinp(p_name text, p_answers jsonb default '{}') returns text language sql as $$
  select api.join_queue(tests.id('queue_pr'), null, p_name, null, null, 1, 'en', gen_random_uuid(), null, null, p_answers)::text
$$;
grant execute on function tests.joinp(text, jsonb) to service_role;

-- AC1: source = appointment
insert into app.priority_rules (id, org_id, location_id, queue_id, priority_class_id, condition_kind, source, rank)
values (tests.new_id('r_appt'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_pr'), tests.id('c_appt'), 'source', 'appointment', 1);
select tests.make_expected_visit('appt1', 'queue_pr', now() + interval '1 hour', 'Appt');
select is((select priority_class_id from app.visits where id = tests.id('appt1')), tests.id('c_appt'),
  'AC1: an appointment visit gets the class of the source rule');
select is((select payload ->> 'priority_rule_id' from app.visit_events where visit_id = tests.id('appt1') and type = 'joined'),
  tests.id('r_appt')::text, 'AC1: the joined event names the rule');

-- AC2: two matching rules, lower rank wins
insert into app.priority_rules (id, org_id, location_id, queue_id, priority_class_id, condition_kind, source, rank) values
  (tests.new_id('r_lo'), tests.id('org_a'), tests.id('loc_a'), null, tests.id('c_lo'), 'source', 'online', 5),
  (tests.new_id('r_hi'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_pr'), tests.id('c_hi'), 'source', 'online', 2);
select tests.as_service();
select tests.joinp('Plain');
select tests.as_postgres();
select is((select priority_class_id from app.visits where guest_name = 'Plain'), tests.id('c_hi'), 'AC2: the lower rank wins');
select is((select payload ->> 'priority_rule_id' from app.visit_events e join app.visits v on v.id = e.visit_id
           where v.guest_name = 'Plain' and e.type = 'joined'), tests.id('r_hi')::text, 'the event names the winning rule');

-- AC3: inactive rules do not match
update app.priority_rules set active = false where id in (tests.id('r_hi'), tests.id('r_lo'));
select tests.as_service();
select tests.joinp('Inactive');
select tests.as_postgres();
select is((select priority_class_id from app.visits where guest_name = 'Inactive'), null, 'AC3: inactive rules assign nothing');

-- an intake answer rule, and the order it produces
insert into app.priority_rules (id, org_id, location_id, queue_id, priority_class_id, condition_kind, field_id, answer_value, rank)
values (tests.new_id('r_ans'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_pr'), tests.id('c_hi'), 'intake_answer',
        tests.id('f_help'), 'access', 1);
select tests.as_service();
select tests.joinp('Needs help', '{"help": "access"}');
select tests.joinp('No help', '{"help": "none"}');
select tests.joinp('Later', '{}');
select tests.as_postgres();
select is((select priority_class_id from app.visits where guest_name = 'Needs help'), tests.id('c_hi'), 'an answer rule classes the matching answer');
select is((select priority_class_id from app.visits where guest_name = 'No help'), null, 'and not another answer');
select is((select string_agg(guest_name, ',' order by sort_key) from app.visits
           where queue_id = tests.id('queue_pr') and status = 'waiting' and guest_name in ('Plain', 'Inactive', 'No help', 'Needs help', 'Later')),
  'Plain,Needs help,Inactive,No help,Later', 'a classed join files ahead of the plain guests who joined less than its offset before it');

-- AC4: cross tenant
select tests.act_as('other_owner');
select is((select count(*)::int from app.priority_rules), 0, 'AC4: org B sees no org A rules');
select throws_ok(format($$ insert into app.priority_rules (org_id, location_id, priority_class_id, condition_kind, source)
                         values (%L, %L, %L, 'source', 'online') $$, tests.id('org_a'), tests.id('loc_a'), tests.id('c_lo')),
  '42501', null, 'AC4: org B cannot insert into org A');
select tests.as_postgres();
select throws_ok(format($$ insert into app.priority_rules (org_id, location_id, priority_class_id, condition_kind, source)
                         values (%L, %L, %L, 'source', 'online') $$, tests.id('org_a'), tests.id('loc_a'), tests.id('c_b')),
  '23503', null, 'a rule cannot point at another org''s class');
select throws_ok(format($$ insert into app.priority_rules (org_id, location_id, priority_class_id, condition_kind, source, answer_value)
                         values (%L, %L, %L, 'source', 'online', 'x') $$, tests.id('org_a'), tests.id('loc_a'), tests.id('c_lo')),
  '23514', null, 'a source rule carries no answer');
select tests.as_anon();
select throws_ok($$ select count(*) from app.priority_rules $$, '42501', null, 'anon has no table access');
select * from finish();
rollback;
