-- X1 follow-up: the text opt-in is offered only where SMS is switched on for the business.
begin;
\ir ../helpers/_setup.psql
select plan(8);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
create table tests.tokens (name text primary key, token text);
grant all on tests.tokens to anon, authenticated;
create function tests.join_as(p_name text, p_phone text) returns void language sql as $$
  insert into tests.tokens
  select p_name, (api.join_queue(tests.id('queue_a'), null, p_name, p_phone, null, 1, 'en', gen_random_uuid())).token
$$;
grant execute on function tests.join_as(text, text) to anon;
create function tests.state(p_name text) returns text language sql security definer as $$
  select (api.get_visit_status(token)).text_consent from tests.tokens where name = p_name
$$;
grant execute on function tests.state(text) to anon;

create table tests.slug as select slug from app.locations where id = tests.id('loc_a');
grant select on tests.slug to anon;
select tests.as_anon();
select tests.join_as('phone', '+14155550155');
select tests.as_postgres();

select is((api.get_location_public((select slug from tests.slug))).sms_enabled, false,
  'no provider settings: sms_enabled is false');
select tests.as_anon();
select is(tests.state('phone'), 'unavailable', 'a number without consent while SMS is off: unavailable');

select tests.as_postgres();
insert into app.provider_settings (org_id, channel, provider, mode, enabled, verified_at)
values (tests.id('org_a'), 'sms', 'dev', 'own', false, now());
select is((api.get_location_public((select slug from tests.slug))).sms_enabled, false,
  'settings saved but not switched on: still false');
update app.provider_settings set enabled = true where org_id = tests.id('org_a') and channel = 'sms';
select tests.as_anon();
select is((api.get_location_public((select slug from tests.slug))).sms_enabled, true,
  'switched on: sms_enabled is true for anon');
select is(tests.state('phone'), 'off', 'switched on: the guest can opt in (off)');

select tests.act_as('staff');
select is(api.location_channels(tests.id('loc_a')), array['sms']::text[], 'staff of the location see the enabled channels');
select tests.act_as('other_owner');
select is(api.location_channels(tests.id('loc_a')), '{}'::text[], 'another org''s owner sees none');
select tests.as_anon();
select throws_ok($$select api.location_channels(null)$$, '42501', null, 'anon cannot call location_channels');

select * from finish();
rollback;
