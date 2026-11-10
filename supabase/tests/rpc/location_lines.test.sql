-- M5 (#1292): api.get_location_lines, the guest provider picker read.
begin;
\ir ../helpers/_setup.psql
select plan(15);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
delete from app.business_hours where location_id = tests.id('loc_b');

create table tests.line_rows as select * from api.get_location_lines('test-location-a') where false;
grant all on tests.line_rows to anon;

-- No provider or pool line yet: no picker, no rows.
select tests.as_anon();
select is((select count(*)::int from api.get_location_lines('test-location-a')), 0,
  'a location without provider or pool lines has no picker');

select tests.as_postgres();
insert into app.queues (id, org_id, location_id, name, ticket_prefix, kind, sort_order) values
  (tests.new_id('pool'), tests.id('org_a'), tests.id('loc_a'), 'Anyone available', 'P', 'pool', 9),
  (tests.new_id('ana'), tests.id('org_a'), tests.id('loc_a'), 'Ana', 'A', 'provider', 2),
  (tests.new_id('ben'), tests.id('org_a'), tests.id('loc_a'), 'Ben', 'B', 'provider', 1),
  (tests.new_id('gone'), tests.id('org_a'), tests.id('loc_a'), 'Retired', 'R', 'provider', 0),
  (tests.new_id('pool_b'), tests.id('org_b'), tests.id('loc_b'), 'Pool B', 'Q', 'pool', 0);
update app.queues set archived_at = now() where id = tests.id('gone');
select tests.new_visit('w1', 'ana');
select tests.new_visit('w2', 'ana');

select tests.as_anon();
select lives_ok($$ insert into tests.line_rows select * from api.get_location_lines('test-location-a') $$,
  'anon can read the lines');
select is((select array_agg(name order by ord) from (
             select name, row_number() over () as ord from tests.line_rows) s
           where name in ('Anyone available', 'Ben', 'Ana')),
  array['Anyone available', 'Ben', 'Ana'], 'the pool comes first, then people by sort order');
select ok(not exists (select 1 from tests.line_rows where name in ('Retired', 'Pool B')),
  'archived lines and other tenants'' lines are not listed');
select is((select kind from tests.line_rows where name = 'Ana'), 'provider', 'each row names its kind');
select is((select waiting_count from tests.line_rows where name = 'Ana'), 2, 'it counts the waiting guests');
select ok((select accepting and not_accepting_reason is null from tests.line_rows where name = 'Ben'),
  'an open line accepts');
select ok(not exists (select 1 from tests.line_rows where selected), 'without p_for nothing is selected');

-- ?for= resolves server-side.
select is((select name from api.get_location_lines('test-location-a', tests.id('ana')::text) where selected),
  'Ana', 'p_for selects the line it names');
select is((select count(*)::int from api.get_location_lines('test-location-a', tests.id('pool_b')::text) where selected), 0,
  'another tenant''s line selects nothing (and is not an error)');
select is((select count(*)::int from api.get_location_lines('test-location-a', 'not-a-uuid') where selected), 0,
  'a malformed p_for selects nothing');

-- A paused line says why.
select tests.as_postgres();
update app.queues set manual_state = 'paused' where id = tests.id('ben');
select tests.as_anon();
select ok((select not accepting and not_accepting_reason is not null
           from api.get_location_lines('test-location-a') where name = 'Ben'), 'a paused line is not accepting and says why');

-- The row carries no guest or contact data.
select is((select array_agg(a.attname::text order by a.attnum) from pg_attribute a
           where a.attrelid = 'api.public_line'::regtype::text::regclass and a.attnum > 0 and not a.attisdropped),
  array['queue_id', 'name', 'kind', 'accepting', 'not_accepting_reason', 'waiting_count', 'eta_state',
        'eta_low', 'eta_high', 'selected'], 'the row type has no names, tickets or contact data');

-- Unknown slug and deleted orgs are not_found.
select throws_ok($$ select * from api.get_location_lines('nope') $$, 'P0001', 'not_found', 'an unknown slug is not_found');
select tests.as_postgres();
update app.organizations set status = 'pending_deletion' where id = tests.id('org_a');
select tests.as_anon();
select throws_ok($$ select * from api.get_location_lines('test-location-a') $$, 'P0001', 'not_found',
  'a location pending deletion is not_found');

select * from finish();
rollback;
