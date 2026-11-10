-- #456 (20261025004700_queue_join_ceiling.sql): a total hourly ceiling on online joins per queue
-- that rotating client identities can't bypass, with kiosk and staff joins outside it.
begin;
\ir ../helpers/_setup.psql
select plan(13);
select tests.create_world();

/** The DETAIL of the error p_sql raises, or null when it succeeds. */
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

/** Sets the request headers PostgREST would pass for a client at p_ip (Kong sets x-real-ip). */
create function tests.from_ip(p_ip text) returns void
language sql as $$
  select set_config('request.headers', jsonb_build_object('x-real-ip', p_ip)::text, true)
$$;
grant execute on function tests.from_ip(text) to anon, authenticated;

create table tests.tokens (name text primary key, token text);
grant all on tests.tokens to anon, authenticated;

delete from app.business_hours where location_id in (tests.id('loc_a'), tests.id('loc_b'));
delete from app.hours_exceptions where location_id in (tests.id('loc_a'), tests.id('loc_b'));
-- join_rate_per_min high enough that only the hourly ceiling applies.
insert into app.queues (id, org_id, location_id, name, ticket_prefix, join_rate_per_min, online_joins_per_hour) values
  (tests.new_id('queue_cap'), tests.id('org_a'), tests.id('loc_a'), 'Capped', 'C', 100, 5),
  (tests.new_id('queue_cap_b'), tests.id('org_b'), tests.id('loc_b'), 'Other org', 'B', 100, 5);
select tests.new_id('key_first');
grant select on tests.ids to anon, authenticated;

select is((select online_joins_per_hour from app.queues where id = tests.id('queue_a')), 120,
  'queues default to 120 online joins an hour');

-- N anon joins from N distinct clients, then one more.
select tests.as_anon();
select tests.from_ip('2001:db8:456:1::1');
insert into tests.tokens
select 'first', (api.join_queue(tests.id('queue_cap'), null, 'First', null, null, 1, null, tests.id('key_first'))).token;
do $$
begin
  for i in 2..5 loop
    perform tests.from_ip('2001:db8:456:' || to_hex(i) || '::1');
    perform api.join_queue(tests.id('queue_cap'), null, 'V6-' || i, null, null, 1, null, gen_random_uuid());
  end loop;
end $$;
select tests.from_ip('2001:db8:456:ffff::1');
select is(tests.error_detail($$ select api.join_queue(tests.id('queue_cap'), null, 'V6-6', null, null, 1, null, gen_random_uuid()) $$),
  'queue_total', 'join N+1 from yet another client is rate_limited (queue_total): no client key bypasses the ceiling');
select throws_ok($$ select api.join_queue(tests.id('queue_cap'), null, 'V6-6', null, null, 1, null, gen_random_uuid()) $$,
  'P0001', 'rate_limited', 'the ceiling raises rate_limited');
select tests.from_ip('2001:db8:456:1::1');
select is((api.join_queue(tests.id('queue_cap'), null, 'First', null, null, 1, null, tests.id('key_first'))).token, null,
  'repeating an accepted join during the ceiling returns that visit, not an error');

-- Leaving does not give the slot back.
select api.guest_act((select token from tests.tokens where name = 'first'), 'leave', gen_random_uuid());
select tests.from_ip('2001:db8:456:fffe::1');
select is(tests.error_detail($$ select api.join_queue(tests.id('queue_cap'), null, 'Rejoin', null, null, 1, null, gen_random_uuid()) $$),
  'queue_total', 'joins that left still count, so leave-and-rejoin from new addresses gains nothing');

-- Staff clearing a junk join gives its slot back; one slot, not more.
select tests.as_postgres();
create temp table junk as
select id, version from app.visits where queue_id = tests.id('queue_cap') and guest_name = 'V6-2';
grant select on junk to authenticated;
select tests.act_as('staff');
select api.transition_visit((select id from junk), 'remove', (select version from junk), gen_random_uuid(), null, 'spam');
select tests.as_anon();
select tests.from_ip('2001:db8:456:fffb::1');
select is((api.join_queue(tests.id('queue_cap'), null, 'After cleanup', null, null, 1, null, gen_random_uuid())).status::text,
  'waiting', 'a visit staff removed no longer counts toward the ceiling');
select tests.from_ip('2001:db8:456:fffa::1');
select is(tests.error_detail($$ select api.join_queue(tests.id('queue_cap'), null, 'One more', null, null, 1, null, gen_random_uuid()) $$),
  'queue_total', 'and only that one slot comes back');

-- Walk-ins are added in the shop during the flood.
select tests.act_as('kiosk');
select is((api.join_queue(tests.id('queue_cap'), null, 'Walk-in', null, null, 1, null, gen_random_uuid())).status::text,
  'waiting', 'a kiosk join still succeeds while online joins are at the ceiling');
select tests.act_as('staff');
select is((api.staff_add_visit(tests.id('queue_cap'), null, 'Phoned in', null, 1, gen_random_uuid())).status::text, 'waiting',
  'a staff add still succeeds while online joins are at the ceiling');

-- Other queues, including another org's, are untouched.
select tests.as_anon();
select tests.from_ip('2001:db8:456:fffd::1');
select is((api.join_queue(tests.id('queue_cap_b'), null, 'Elsewhere', null, null, 1, null, gen_random_uuid())).status::text,
  'waiting', 'a flood on one org''s queue does not use up another org''s queue');
select is((api.join_queue(tests.id('queue_a'), null, 'Next door', null, null, 1, null, gen_random_uuid())).status::text,
  'waiting', 'nor another queue of the same org');

-- The window rolls: an hour later the queue takes online joins again.
select tests.as_postgres();
update app.visits set joined_at = now() - interval '61 minutes'
where queue_id = tests.id('queue_cap') and source = 'online';
select tests.as_anon();
select tests.from_ip('2001:db8:456:fffc::1');
select is((api.join_queue(tests.id('queue_cap'), null, 'Later', null, null, 1, null, gen_random_uuid())).status::text,
  'waiting', 'online joins older than an hour no longer count');

select tests.as_postgres();
select is((select count(*)::int from app.visits where queue_id = tests.id('queue_cap') and source <> 'online'), 2,
  'kiosk and staff joins were added and are not counted as online');

select * from finish();
rollback;
