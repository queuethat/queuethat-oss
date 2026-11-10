-- 2A-ST7 (#140): api.search_visits.
begin;
\ir ../helpers/_setup.psql
select plan(17);
select tests.create_world();

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_s'), tests.id('org_a'), tests.id('loc_a'), 'Search', 'S');
insert into app.services (id, org_id, location_id, queue_id, name)
values (tests.new_id('svc_s'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_s'), 'Colour');
select tests.new_visit('s1', 'queue_s', 'Gina Marsh');
select tests.new_visit('s2', 'queue_s', 'Omar');
select tests.new_visit('s3', 'queue_s', '100% Pat_');
update app.visits set contact_id = tests.id('contact_a'), service_id = tests.id('svc_s') where id = tests.id('s1');
-- an old visit, outside a one-day window
update app.visits set service_day = service_day - 3 where id = tests.id('s2');

create function tests.found(p_query text, p_days int default 1) returns text language sql as $$
  select coalesce(string_agg(n, ',' order by n), '') from (
    select (select k from (values ('s1'), ('s2'), ('s3')) as t(k) where tests.id(k) = r.id) as n
    from api.search_visits(tests.id('loc_a'), p_query, p_days) r) x
$$;
grant execute on function tests.found(text, int) to authenticated;

select tests.act_as('staff');
select is(tests.found('0123'), 's1', 'AC1: the last digits of +14155550123 find the visit');
select is(tests.found('23'), '', 'AC1: two digits do not match a phone');
select is(tests.found('(415) 555-0123'), 's1', 'a formatted full number matches');
select is(tests.found('gina'), 's1', 'a name matches, ignoring case');
select is(tests.found('colour'), 's1', 'a service name matches');
select is(tests.found('S00'), 's1,s3', 'a ticket prefix matches');
select is(tests.found('100%'), 's3', 'LIKE wildcards in the query are literal');
select is(tests.found('omar'), '', 'a visit from 3 days ago is outside a 1-day window');
select is(tests.found('omar', 7), 's2', 'and inside a 7-day window');
select is((select count(*)::int from api.search_visits(tests.id('loc_a'), '0123')), 1, 'results are visit rows (no contact column)');
select throws_ok($$ select * from api.search_visits(tests.id('loc_a'), 'a') $$, 'P0001', 'invalid_input', 'one character is too short');

select tests.as_postgres();
delete from private.search_log;
select tests.act_as('staff');
do $$ begin for i in 1..30 loop perform count(*) from api.search_visits(tests.id('loc_a'), 'gi'); end loop; end $$;
select throws_ok($$ select * from api.search_visits(tests.id('loc_a'), 'gi') $$, 'P0001', 'rate_limited', 'AC2: the 31st search in a minute is rate_limited');

-- phone-mode searches are capped lower, and the cap is per user
select tests.as_postgres();
delete from private.search_log;
select tests.act_as('staff');
do $$ begin for i in 1..10 loop perform count(*) from api.search_visits(tests.id('loc_a'), '0123'); end loop; end $$;
select throws_ok($$ select * from api.search_visits(tests.id('loc_a'), '0123') $$, 'P0001', 'rate_limited', 'the 11th phone search in a minute is rate_limited');
select lives_ok($$ select * from api.search_visits(tests.id('loc_a'), 'gina') $$, 'name searches still work below the overall cap');
select tests.as_postgres();
delete from private.search_log;
insert into private.search_log (user_id, location_id) select tests.id('manager'), tests.id('loc_a') from generate_series(1, 120);
select tests.act_as('staff');
select throws_ok($$ select * from api.search_visits(tests.id('loc_a'), 'gina') $$, 'P0001', 'rate_limited', 'a location-wide cap stops many accounts together');

select tests.act_as('other_owner');
select throws_ok($$ select * from api.search_visits(tests.id('loc_a'), 'gina') $$, 'P0001', 'not_found', 'AC3: staff of org B get not_found for an org A location');
select tests.as_anon();
select throws_ok($$ select * from api.search_visits(tests.id('loc_a'), 'gina') $$, '42501', null, 'anon cannot search');

select * from finish();
rollback;
