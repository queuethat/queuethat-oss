-- 2A-J15A (#117): several parties under one phone number, linked by a group key and capped per queue.
begin;
\ir ../helpers/_setup.psql
select plan(10);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
select tests.new_id(k) from unnest(array['g', 'k1', 'k2', 'k3', 'k4', 'k5', 'kb', 'ks1', 'ks2']) k;

create function tests.next_ticket_after(p text) returns text
language sql immutable as $$ select 'A' || lpad((substr(p, 2)::int + 1)::text, 3, '0') $$;
grant execute on function tests.next_ticket_after(text) to anon, authenticated;
create function tests.join_as(p_queue text, p_name text, p_phone text, p_key text, p_group text, p_device text default null)
returns text language plpgsql as $$
begin
  return (api.join_queue(p_queue_id => tests.id(p_queue), p_service_id => null, p_name => p_name,
    p_phone_e164 => p_phone, p_email => null, p_party_size => 1, p_locale => null,
    p_idempotency_key => tests.id(p_key), p_device_key => p_device,
    p_group_key => case when p_group is null then null else tests.id(p_group) end)).display_ticket;
exception when others then
  return sqlerrm;
end $$;
grant execute on function tests.join_as(text, text, text, text, text, text) to anon, authenticated;

-- AC1: one phone, three visits, one group, consecutive tickets
create table tests.t (n text primary key, v text);
grant all on tests.t to anon, authenticated;
select tests.as_anon();
select set_config('request.headers', '{"x-real-ip": "198.51.100.50"}', true);
insert into tests.t values ('1', tests.join_as('queue_a', 'Sam', '+14155550101', 'k1', 'g', 'parent-device-key-0000001'));
insert into tests.t values ('2', tests.join_as('queue_a', 'Kim', '+14155550101', 'k2', 'g', 'parent-device-key-0000001'));
insert into tests.t values ('3', tests.join_as('queue_a', 'Lee', '+14155550101', 'k3', 'g', 'parent-device-key-0000001'));
select is((select count(distinct v)::int from tests.t where v ~ '^A[0-9]{3}$'), 3,
  'a second and third person from the same phone and device join (a group skips the device replay)');
select is((select substr(v, 2)::int - lag from (select v, substr(lag(v) over (order by n), 2)::int as lag from tests.t) x where lag is not null order by 1 desc limit 1), 1,
  'with consecutive tickets');
select tests.as_postgres();
select is((select count(*)::int from app.visits where group_key = tests.id('g')), 3, 'AC1: three visits share the group key');
select tests.as_anon();
select is(tests.join_as('queue_a', 'Sam', '+14155550101', 'k1', 'g', 'parent-device-key-0000001'), (select v from tests.t where n = '1'),
  'a repeat of the first call (double tap) is the same visit, not a fourth');
select tests.as_postgres();
select is((select count(*)::int from app.visits where group_key = tests.id('g')), 3, 'and no new visit exists');

-- AC2: the cap
update app.queues set max_active_per_contact = 3 where id = tests.id('queue_a');
select tests.as_anon();
select is(tests.join_as('queue_a', 'Max', '+14155550101', 'k4', 'g', 'parent-device-key-0000001'), 'too_many_active_visits',
  'AC2: past max_active_per_contact the same phone is refused');
select is(tests.join_as('queue_a', 'Max', '+14155550102', 'k5', 'g', 'parent-device-key-0000001'), 'too_many_active_visits',
  'a group key does not dodge the cap: the device holds the same number of visits');
select is(tests.join_as('queue_a', 'Zed', '+14155550103', 'kb', null, 'other-device-key-00000001'), tests.next_ticket_after((select v from tests.t where n = '3')), 'another phone and device is unaffected');

-- Staff adds are exempt from the cap
select tests.act_as('staff');
select lives_ok($$ select api.staff_add_visit(tests.id('queue_a'), null, 'Walk-in', '+14155550101', 1, tests.id('ks1')) $$,
  'a staff add ignores the cap');

-- AC3: a group key from org A in an org B join is an unrelated group
select tests.as_postgres();
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'B queue', 'B');
select tests.as_anon();
select tests.join_as('queue_b', 'Bea', '+14155550101', 'ks2', 'g', 'parent-device-key-0000002');
select tests.as_postgres();
select is((select count(*)::int from app.visits where group_key = tests.id('g') and org_id = tests.id('org_b')), 1,
  'AC3: the org B join stores its own row; the groups are separate per org and cap counts stay per queue');

select * from finish();
rollback;
