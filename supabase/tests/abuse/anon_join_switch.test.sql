-- 2A-JN4 (#114): deployment_settings.anon_join_enabled closes the direct anonymous join.
begin;
\ir ../helpers/_setup.psql
select plan(9);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
select tests.new_id(k) from unnest(array['j1', 'j2', 'j3', 'j4', 'j5', 'j6']) k;

create function tests.join_as_caller(p_key text) returns text
language plpgsql as $$
declare
  err_detail text;
begin
  perform api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => null, p_name => 'G',
    p_phone_e164 => null, p_email => null, p_party_size => 1, p_locale => null,
    p_idempotency_key => tests.id(p_key));
  return 'ok';
exception when others then
  get stacked diagnostics err_detail = pg_exception_detail;
  return sqlerrm || coalesce(' / ' || err_detail, '');
end $$;
grant execute on function tests.join_as_caller(text) to anon, authenticated, service_role;

select is((select anon_join_enabled from private.deployment_settings), true,
  'the direct path is open by default, so guest bundles already in browsers keep working');

select set_config('request.headers', '{"x-real-ip": "198.51.100.77"}', true);
select tests.as_anon();
select is(tests.join_as_caller('j1'), 'ok', 'open: an anon join works');

select tests.as_postgres();
update private.deployment_settings set anon_join_enabled = false;

select tests.as_anon();
select is(tests.join_as_caller('j2'), 'captcha_required / public_join',
  'AC1: closed: an anon join is refused, and the reason says to use the public join');

select tests.act_as('kiosk');
select is(tests.join_as_caller('j3'), 'ok', 'AC2: closed: a kiosk of the location still joins');

select tests.as_service();
select is(tests.join_as_caller('j4'), 'ok', 'closed: the service role (the public-join function) still joins');

select tests.act_as('staff');
select is(tests.join_as_caller('j5'), 'captcha_required / public_join',
  'closed: a signed-in non-kiosk account is refused too (sign-up is open, so it is as cheap as anon)');

select tests.as_postgres();
select is((select count(*)::int from app.visits
           where idempotency_key in (tests.id('j1'), tests.id('j2'), tests.id('j3'), tests.id('j4'), tests.id('j5'))), 3,
  'refused joins made no visit (open anon, kiosk, service role)');

update private.deployment_settings set anon_join_enabled = true;
select tests.as_anon();
select is(tests.join_as_caller('j6'), 'ok', 'reopened: the rollback is one update, and anon joins again');

select tests.as_postgres();
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'api' and p.proname = 'join_queue'), 1,
  'still one join_queue: no variant was added');

select * from finish();
rollback;
