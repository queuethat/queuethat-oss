-- 3-CG6 (#331): the status page learns whether texts are on, and the consent text names the location.
begin;
\ir ../helpers/_setup.psql
select plan(6);
select tests.create_world();
insert into app.provider_settings (org_id, channel, provider, mode, enabled, verified_at)
values (tests.id('org_a'), 'sms', 'dev', 'own', true, now());

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
select tests.as_anon();
select tests.join_as('nophone', null);
select tests.join_as('phone', '+14155550155');
select is(tests.state('nophone'), 'none', 'no number: none');
select is(tests.state('phone'), 'off', 'a number without consent: off');
select tests.as_postgres();
create table tests.hash as select encode(sha256(convert_to(private.render_consent_text(tests.id('loc_a'), 'sms', 'transactional', 'en', 2), 'UTF8')), 'hex') h;
grant select on tests.hash to anon;
select tests.as_anon();
select api.guest_grant_consent((select token from tests.tokens where name = 'phone'), 'sms', 2, (select h from tests.hash), 'en');
select is(tests.state('phone'), 'on', 'after a granted consent: on');
select tests.as_postgres();
update app.consents set status = 'revoked', revoked_at = now() where contact_id in (select contact_id from app.visits where guest_phone_e164 = '+14155550155');
select tests.as_anon();
select is(tests.state('phone'), 'off', 'a revoked consent is off again');
select tests.as_postgres();
select matches(private.render_consent_text(tests.id('loc_a'), 'sms', 'transactional', 'en', 2),
  (select l.name from app.locations l where l.id = tests.id('loc_a')) || ' will text you only about this visit',
  'the text names the location');
select matches(private.render_consent_text(tests.id('loc_a'), 'sms', 'transactional', 'en', 2),
  'Questions: ' || (select coalesce(l.contact, l.name) from app.locations l where l.id = tests.id('loc_a')) || '\.$',
  'and gives its contact, or its name when it has none');
select * from finish();
rollback;
