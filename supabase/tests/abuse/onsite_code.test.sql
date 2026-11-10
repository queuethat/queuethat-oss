-- 2A-JN5 (#115): rotating on-site join code.
begin;
\ir ../helpers/_setup.psql
select plan(14);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
update app.locations set onsite_code_required = true, onsite_code_rotate_minutes = 5 where id = tests.id('loc_a');
select tests.new_id(k) from unnest(array['k1', 'k2', 'k3', 'k4', 'k5', 'k6']) k;
create table tests.codes (name text primary key, code text);
grant all on tests.codes to anon, authenticated;

create function tests.join_with(p_key text, p_code text) returns text
language plpgsql as $$
begin
  perform api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => null, p_name => 'G',
    p_phone_e164 => null, p_email => null, p_party_size => 1, p_locale => null,
    p_idempotency_key => tests.id(p_key), p_onsite_code => p_code);
  return 'ok';
exception when others then
  return sqlerrm;
end $$;
grant execute on function tests.join_with(text, text) to anon, authenticated;

-- The window is fixed so the test does not depend on the clock: now() is the transaction start.
insert into tests.codes values
  ('now', private.onsite_code(tests.id('loc_a'), now())),
  ('prev', private.onsite_code(tests.id('loc_a'), now() - interval '5 minutes')),
  ('old', private.onsite_code(tests.id('loc_a'), now() - interval '10 minutes'));
select matches((select code from tests.codes where name = 'now'), '^[0-9]{4}$', 'the code is 4 digits');
select is(private.onsite_code(tests.id('loc_a'), now()), (select code from tests.codes where name = 'now'), 'deterministic for one instant');

-- Display: required flag, code, valid_until
select tests.act_as('display');
select is((api.display_onsite_code(tests.id('loc_a'))).code, (select code from tests.codes where name = 'now'),
  'a display device of the location reads the current code');
select ok((api.display_onsite_code(tests.id('loc_a'))).valid_until > now()
          and (api.display_onsite_code(tests.id('loc_a'))).valid_until <= now() + interval '5 minutes',
  'valid_until is the end of the current window');
select tests.act_as('staff');
select is((api.display_onsite_code(tests.id('loc_a'))).required, true, 'staff of the location can read it too');
-- AC3
select tests.act_as('kiosk');
select throws_ok($$ select api.display_onsite_code(tests.id('loc_a')) $$, 'P0001', 'not_found',
  'a kiosk device may not read the code');
select tests.act_as('other_owner');
select throws_ok($$ select api.display_onsite_code(tests.id('loc_a')) $$, 'P0001', 'not_found',
  'AC3: another tenant''s caller is denied');
-- AC4
select tests.act_as('owner');
select throws_ok($$ select count(*) from private.location_secrets $$, '42501', null,
  'AC4: authenticated cannot select private.location_secrets');
select tests.as_anon();
select throws_ok($$ select count(*) from private.location_secrets $$, '42501', null,
  'AC4: nor can anon');

-- Joins
select set_config('request.headers', '{"x-real-ip": "198.51.100.40"}', true);
select is(tests.join_with('k1', null), 'onsite_code_required', 'a public join without the code is refused');
-- AC1
select is(tests.join_with('k2', (select code from tests.codes where name = 'old')),
  case when (select code from tests.codes where name = 'old') in
       ((select code from tests.codes where name = 'now'), (select code from tests.codes where name = 'prev'))
       then 'ok' else 'onsite_code_invalid' end,
  'AC1: the code from two windows ago is invalid');
select is(tests.join_with('k3', (select code from tests.codes where name = 'prev')), 'ok',
  'the previous window still works');
select is(tests.join_with('k4', (select code from tests.codes where name = 'now')), 'ok', 'the current window works');
-- AC2
select tests.act_as('kiosk');
select is(tests.join_with('k5', null), 'ok', 'AC2: a kiosk join needs no code');

select * from finish();
rollback;
