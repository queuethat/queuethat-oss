-- 2P-CRM2 (#185): guest search, profile and badges.
begin;
\ir ../helpers/_setup.psql
select plan(12);
select tests.create_world();

select tests.as_postgres();
update app.guests set first_name = 'Gina' where id = tests.id('guest_a');
select private.set_actor('system', null);
update app.visits set guest_id = tests.id('guest_a') where id = tests.id('visit_a');

select tests.act_as('staff');
select throws_ok($$ select * from api.search_guests(tests.id('loc_a'), 'Gi') $$, 'P0001', 'query_too_short',
  'AC1: a 2-character query is refused');
select is((select name from api.search_guests(tests.id('loc_a'), 'gin')), 'Gina', 'name prefix finds the guest');
select is((select masked_contact from api.search_guests(tests.id('loc_a'), 'gin')), '+•••••••0123',
  'the contact is masked');
select is((select count(*) from api.search_guests(tests.id('loc_a'), '0123')), 1::bigint,
  'the last 4 digits of a phone find the guest');
select is((select count(*) from api.search_guests(tests.id('loc_a'), '%%%')), 0::bigint,
  'LIKE wildcards are matched literally, not as a broad query');

select is((api.get_guest(tests.id('guest_a'))).visit_count, 1, 'get_guest counts visits');
select is(jsonb_array_length((api.get_guest(tests.id('guest_a'))).contacts), 1, 'get_guest lists contacts');
select is((select visit_count from api.guest_badges(array[tests.id('visit_a')])), 1, 'guest_badges counts the guest''s visits');

select tests.as_postgres();
insert into app.guests (org_id, first_name) select tests.id('org_a'), 'Zed ' || n from generate_series(1, 30) n;
select tests.act_as('staff');
select is((select count(*) from api.search_guests(tests.id('loc_a'), 'zed')), 25::bigint, 'AC1: a broad query returns at most 25');

select tests.act_as('other_owner');
select throws_ok($$ select api.get_guest(tests.id('guest_a')) $$, 'P0001', 'not_found', 'AC2: org B cannot open an org A guest');
select is((select count(*) from api.guest_badges(array[tests.id('visit_a')])), 0::bigint, 'AC2: org A visit ids give org B nothing');

select tests.as_postgres();
update app.guests set anonymized_at = now() where id = tests.id('guest_a');
select tests.act_as('staff');
select is((select count(*) from api.search_guests(tests.id('loc_a'), 'gin')), 0::bigint, 'AC3: anonymized guests are not returned');

select * from finish();
rollback;
