-- 2B-J8 (#246): visit attribution from the public-join source hint.
begin;
\ir ../helpers/_setup.psql
select plan(6);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
select tests.new_id(k) from unnest(array['k1', 'k2', 'k3', 'k4', 'k5']) k;

create function tests.join_src(p_key text, p_src text, p_as text default 'service') returns text
language plpgsql as $$
begin
  if p_as = 'service' then perform tests.as_service(); else perform tests.as_anon(); end if;
  perform set_config('request.headers', jsonb_build_object('x-qm-src', p_src)::text, true);
  perform api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => null, p_name => 'G',
    p_phone_e164 => null, p_email => null, p_party_size => 1, p_locale => null,
    p_idempotency_key => tests.id(p_key));
  return 'ok';
exception when others then
  return sqlerrm;
end $$;
grant execute on function tests.join_src(text, text, text) to anon, authenticated, service_role;
create function tests.attr(p_key text) returns text language sql as $$
  select coalesce(attribution, '-') from app.visits where idempotency_key = tests.id(p_key) $$;

select is(tests.join_src('k1', 'gbp'), 'ok', 'a gbp join succeeds');
select tests.as_postgres();
select is(tests.attr('k1'), 'gbp', 'AC1: the visit is attributed to gbp');
select is(tests.join_src('k2', '<script>alert(1)</script>'), 'ok', 'a hostile value still joins');
select tests.as_postgres();
select is(tests.attr('k2'), '-', 'AC2: nothing from an unknown value is stored');
select is(tests.join_src('k3', 'widget', 'anon'), 'ok', 'anon can join');
select tests.as_postgres();
select is(tests.attr('k3'), '-', 'anyone but the service role cannot set attribution');

select * from finish();
rollback;
