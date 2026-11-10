-- 2A-Q4 (#103): a service can override the queue's ticket prefix; tickets number per prefix.
begin;
\ir ../helpers/_setup.psql
select plan(9);
select tests.create_world();
select tests.new_id(k) from unnest(array['k1','k2','k3','k4','k5']) k;
delete from app.business_hours;

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_p'), tests.id('org_a'), tests.id('loc_a'), 'Counter', 'A');
insert into app.services (id, org_id, location_id, queue_id, name, ticket_prefix) values
  (tests.new_id('svc_reg'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_p'), 'Registrations', 'B'),
  (tests.new_id('svc_lic'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_p'), 'Licences', null);

create function tests.tix(p_key text, p_service text) returns text
language sql as $$
  select (api.join_queue(p_queue_id => tests.id('queue_p'), p_service_id => tests.id(p_service), p_name => 'G',
    p_phone_e164 => null, p_email => null, p_party_size => 1, p_locale => null,
    p_idempotency_key => tests.id(p_key))).display_ticket
$$;
grant execute on function tests.tix(text, text) to anon, authenticated;

select tests.as_anon();
select set_config('request.headers', '{"x-real-ip": "198.51.100.40"}', true);
select is(tests.tix('k1', 'svc_reg'), 'B001', 'AC1: first Registrations guest is B001');
select is(tests.tix('k2', 'svc_reg'), 'B002', 'AC1: second is B002');
select is(tests.tix('k3', 'svc_lic'), 'A001', 'AC1: a Licences guest uses the queue prefix, A001');
select tests.as_postgres();
select is((select ticket_prefix from app.visits where idempotency_key = tests.id('k1')), 'B', 'the visit stores the effective prefix');

-- A staff add goes through the same core.
select tests.act_as('staff');
select is((select display_ticket from api.staff_add_visit(tests.id('queue_p'), tests.id('svc_reg'), 'Walk', null, 1, tests.id('k4'))), 'B003',
  'staff_add_visit also numbers per service prefix');

-- Constraint.
select tests.as_postgres();
select throws_ok($$ update app.services set ticket_prefix = 'b1' where id = tests.id('svc_reg') $$, '23514', null,
  'a prefix must be 1 to 3 uppercase letters');
select lives_ok($$ update app.services set ticket_prefix = null where id = tests.id('svc_reg') $$, 'a prefix can be cleared');

-- AC3: cross tenant.
select tests.act_as('other_owner');
update app.services set ticket_prefix = 'Z' where id = tests.id('svc_reg');
select tests.as_postgres();
select is((select ticket_prefix from app.services where id = tests.id('svc_reg')), null, 'AC3: org B cannot set a prefix on an org A service (RLS hides the row)');
select tests.act_as('manager');
update app.services set ticket_prefix = 'R' where id = tests.id('svc_reg');
select tests.as_postgres();
select is((select ticket_prefix from app.services where id = tests.id('svc_reg')), 'R', 'a manager of the org can');

select * from finish();
rollback;
