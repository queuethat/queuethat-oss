-- 2B-J1 (#239): single active visit across queues and locations (J-16).
begin;
\ir ../helpers/_setup.psql
select plan(10);
select tests.create_world();
delete from app.business_hours;
delete from app.hours_exceptions;

insert into app.queues (id, org_id, location_id, name, ticket_prefix, max_active_per_contact) values
  (tests.new_id('qa'), tests.id('org_a'), tests.id('loc_a'), 'Alpha', 'X', 1),
  (tests.new_id('qb'), tests.id('org_a'), tests.id('loc_a'), 'Beta', 'Y', 1),
  (tests.new_id('qo'), tests.id('org_b'), tests.id('loc_b'), 'Other org', 'O', 1);

create function tests.sjoin(p_queue text, p_name text, p_phone text, p_device text default null) returns text language sql as $$
  select api.join_queue(tests.id(p_queue), null, p_name, p_phone, null, 1, 'en', gen_random_uuid(), p_device)::text
$$;
create function tests.sdetail(p_sql text) returns text language plpgsql as $$
declare d text;
begin execute p_sql; return null;
exception when others then get stacked diagnostics d = pg_exception_detail; return coalesce(sqlerrm, '') || '/' || coalesce(d, '');
end $$;
grant execute on function tests.sjoin(text, text, text, text), tests.sdetail(text) to service_role;

-- AC2: off by default, the same phone joins twice
select tests.as_service();
select tests.sjoin('qa', 'One', '+14155550123');
select tests.sjoin('qb', 'Two', '+14155550123');
select tests.as_postgres();
select is((select count(*)::int from app.visits where guest_phone_e164 = '+14155550123'), 2, 'AC2: scope off, both joins succeed');
select private.set_actor('system', null, 'cancel');
update app.visits set status = 'cancelled' where guest_phone_e164 = '+14155550123';

-- AC1: org scope, another queue refuses
update app.organizations set single_active_visit = 'org' where id = tests.id('org_a');
select tests.as_service();
select tests.sjoin('qa', 'Three', '+14155550123', 'AAAAAAAAAAAAAAAAAAAAAA');
select throws_ok($$ select tests.sjoin('qb', 'Four', '+14155550123') $$, 'P0001', 'already_in_queue', 'AC1: the same phone in another queue is refused');
select is(tests.sdetail($$ select tests.sjoin('qb', 'Four', '+14155550123') $$), 'already_in_queue/contact', 'a typed phone alone does not name the other queue');
select is(tests.sdetail($$ select tests.sjoin('qb', 'Five', '+14155550999', 'AAAAAAAAAAAAAAAAAAAAAA') $$), 'already_in_queue/Alpha', 'the same device is told which queue');
select tests.as_postgres();
select is((select count(*)::int from app.visits where guest_name in ('Four', 'Five')), 0, 'refused joins create nothing');

-- location scope: another location of the org is allowed
update app.organizations set single_active_visit = 'location' where id = tests.id('org_a');
insert into app.locations (id, org_id, name, slug, tz) values (tests.new_id('loc_a2'), tests.id('org_a'), 'Second', 'second-loc', 'UTC');
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values (tests.new_id('qa2'), tests.id('org_a'), tests.id('loc_a2'), 'Elsewhere', 'E');
select tests.as_service();
select tests.sjoin('qa2', 'Elsewhere guest', '+14155550123');
select tests.as_postgres();
select is((select count(*)::int from app.visits where guest_name = 'Elsewhere guest'), 1, 'location scope allows another location');

-- AC3: served, joins again
select private.set_actor('system', null, 'cancel');
update app.visits set status = 'cancelled' where guest_name = 'Three';
update app.organizations set single_active_visit = 'org' where id = tests.id('org_a');
select private.set_actor('system', null, 'cancel');
update app.visits set status = 'cancelled' where guest_name = 'Elsewhere guest';
select tests.as_service();
select tests.sjoin('qb', 'Again', '+14155550123');
select tests.as_postgres();
select is((select count(*)::int from app.visits where guest_name = 'Again'), 1, 'AC3: after the first visit ended the guest joins again');

-- AC4: other org's visit does not count
update app.organizations set single_active_visit = 'org' where id = tests.id('org_b');
select tests.as_service();
select tests.sjoin('qo', 'Org B guest', '+14155550123');
select tests.as_postgres();
select is((select count(*)::int from app.visits where guest_name = 'Org B guest'), 1, 'AC4: no cross-tenant matching');

-- staff add is exempt and flagged
select tests.act_as('staff');
select api.staff_add_visit(tests.id('qa'), null, 'Staff added', '+14155550123', 1, gen_random_uuid());
select tests.as_postgres();
select is((select e.payload ->> 'warning' from app.visit_events e join app.visits v on v.id = e.visit_id
           where v.guest_name = 'Staff added' and e.type = 'joined'), 'already_in_queue', 'a staff add goes through with a warning on the joined event');
select is((select count(*)::int from pg_proc where proname = 'check_join_restriction' and pronamespace = 'private'::regnamespace), 1, 'the join restriction hook exists');
select * from finish();
rollback;
