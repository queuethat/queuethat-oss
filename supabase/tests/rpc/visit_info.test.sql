-- 2A-GST2 (#123): visits.scan_code, api.get_visit_info and api.find_visit_by_scan_code.
begin;
\ir ../helpers/_setup.psql
select plan(15);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
update app.locations set address = 'Rue de l''Église 5, Zürich', contact = '+41 44 000 00 00'
where id = tests.id('loc_a');

create table tests.tokens (name text primary key, token text);
grant insert, select on tests.tokens to anon;
select set_config('request.headers', '{"x-real-ip": "198.51.100.77"}', true);
select tests.as_anon();
insert into tests.tokens
  select 'ann', (api.join_queue(tests.id('queue_a'), null, 'Ann', '+14155550123', 'ann@example.com', 1, 'en',
                                gen_random_uuid())).token;
select tests.as_postgres();

-- scan_code
select matches((select scan_code from app.visits where guest_name = 'Ann'), '^[0-9A-HJKMNP-TV-Z]{10}$',
  'a new visit gets a 10-character Crockford base32 scan code');
select is((select count(distinct scan_code)::int from app.visits where location_id = tests.id('loc_a')),
  (select count(*)::int from app.visits where location_id = tests.id('loc_a')), 'codes are unique in the location');
select is(private.url_encode('Rue de l''Église 5'), 'Rue%20de%20l%27%C3%89glise%205', 'url_encode escapes bytes');

-- AC1: get_visit_info
create table tests.expect as select name from app.locations where id = tests.id('loc_a');
grant select on tests.expect to anon;
create table tests.info as select * from api.get_visit_info('x') where false;
grant all on tests.info to anon;
select tests.as_anon();
insert into tests.info select * from api.get_visit_info((select token from tests.tokens where name = 'ann'));
select is((select location_name from tests.info), (select name from tests.expect),
  'location name');
select is((select phone from tests.info), '+41 44 000 00 00', 'location phone');
select is((select directions_url from tests.info),
  'https://www.google.com/maps/search/?api=1&query=Rue%20de%20l%27%C3%89glise%205%2C%20Z%C3%BCrich', 'maps link');
select is((select hours_today->>'open_now' from tests.info), 'true', 'no hours means open all day');
select ok((select scan_code ~ '^[0-9A-HJKMNP-TV-Z]{10}$' and locale = 'en' from tests.info), 'scan code and locale');
select ok(not exists (select 1 from tests.info i
    where to_jsonb(i)::text ~* '(4155550123|ann@example|Ann\M)'),
  'AC1: no phone, email, name or answer of the guest in the result');
select throws_ok($$ select api.get_visit_info('nonsense') $$, 'P0001', 'not_found', 'an unknown token is not_found');

-- find_visit_by_scan_code
select tests.as_postgres();
create table tests.code as select scan_code, id from app.visits where guest_name = 'Ann';
grant select on tests.code to authenticated, anon;
select tests.act_as('staff');
select is((select (r).id from (select api.find_visit_by_scan_code(tests.id('loc_a'),
    lower((select scan_code from tests.code))) as r) x), (select id from tests.code),
  'staff of the location resolve a scanned code (case is ignored)');
select tests.act_as('other_owner');
select throws_ok(format($$ select api.find_visit_by_scan_code(%L, %L) $$, tests.id('loc_a'), (select scan_code from tests.code)),
  'P0001', 'not_found', 'AC2: staff of org B get not_found for an org A code');
select tests.as_anon();
select throws_ok(format($$ select api.find_visit_by_scan_code(%L, %L) $$, tests.id('loc_a'), (select scan_code from tests.code)),
  '42501', null, 'anon cannot call it');

-- AC3: yesterday's code
select tests.as_postgres();
select private.set_actor('system', null);
update app.visits set service_day = service_day - 1 where id = (select id from tests.code);
select tests.act_as('staff');
select throws_ok(format($$ select api.find_visit_by_scan_code(%L, %L) $$, tests.id('loc_a'), (select scan_code from tests.code)),
  'P0001', 'not_found', 'AC3: a code from an earlier service day is not_found');
select throws_ok(format($$ select api.find_visit_by_scan_code(%L, 'NOTACODE') $$, tests.id('loc_a')),
  'P0001', 'not_found', 'an unknown code is not_found');

select * from finish();
rollback;
