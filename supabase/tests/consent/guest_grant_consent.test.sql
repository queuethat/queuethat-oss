-- 3-CG5 (#330): consent copy is versioned; a guest's consent stores the version and hash they saw.
begin;
\ir ../helpers/_setup.psql
select plan(37);
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
select tests.as_anon();
select tests.join_as('gv', '+14155550188');
select tests.join_as('gv_nophone', null);
select tests.join_as('gv_b', '+14155550999'); -- opted out in the fixture
select tests.join_as('gv_known', '+14155550123'); -- a number the org already holds (contact_a)
select api.guest_act((select token from tests.tokens where name = 'gv_nophone'), 'leave', gen_random_uuid());
select tests.as_postgres();

create function tests.t(p text) returns text language sql security definer as $$
  select token from tests.tokens where name = p
$$;
grant execute on function tests.t(text) to anon, authenticated;
create table tests.hashes as
  select c, encode(sha256(convert_to(private.render_consent_text(tests.id('loc_a'), c::app.notification_channel,
    'transactional', 'en', case c when 'sms' then 2 else 1 end), 'UTF8')), 'hex') as h
  from unnest(array['sms', 'whatsapp']) c;
grant select on tests.hashes to anon, authenticated;
create table tests.v1_hash as
  select encode(sha256(convert_to(private.render_consent_text(tests.id('loc_a'), 'sms', 'transactional', 'en', 1), 'UTF8')), 'hex') as h;
grant select on tests.v1_hash to anon, authenticated;
create function tests.expected_hash(p_channel text, p_version int default null) returns text language sql as $$
  select h from tests.hashes where c = p_channel
$$;
-- The newest published version per channel: sms is at 2 (frequency wording), whatsapp at 1.
create function tests.grant_consent(p_token text, p_channel text default 'sms', p_version int default null, p_hash text default null)
returns api.consent_row language sql as $$
  select api.guest_grant_consent(p_token, p_channel, coalesce(p_version, case p_channel when 'sms' then 2 else 1 end), coalesce(p_hash, tests.expected_hash(p_channel, p_version)), 'en')
$$;
grant execute on function tests.grant_consent(text, text, int, text), tests.expected_hash(text, int) to anon, authenticated;

-- The rendered text names the business and carries the compliance lines.
select matches(private.render_consent_text(tests.id('loc_a'), 'sms', 'transactional', 'en', 2),
  'Msg frequency varies\. Msg & data rates may apply\. Reply STOP to opt out, HELP for help', 'v2 sms copy has frequency, rates, STOP and HELP');
select doesnt_match(private.render_consent_text(tests.id('loc_a'), 'sms', 'transactional', 'en', 2), '\{\{', 'placeholders are filled');
select matches(private.render_consent_text(tests.id('loc_a'), 'sms', 'transactional', 'es', 1),
  'La frecuencia de mensajes varía\..*STOP.*HELP', 'the Spanish sms copy has frequency, rates, STOP and HELP');
select doesnt_match(private.render_consent_text(tests.id('loc_a'), 'sms', 'transactional', 'es', 1), '\{\{', 'and its placeholders are filled');
select matches(private.render_consent_text(tests.id('loc_a'), 'sms', 'transactional', 'en', 1), 'Msg & data rates may apply\. Reply STOP', 'v1 stays published, word for word, for the consents that saw it');
select is(private.render_consent_text(tests.id('loc_a'), 'sms', 'transactional', 'en', 99), null, 'unknown version renders nothing');

select tests.as_anon();
-- AC1
select results_eq($$ select (r).channel, (r).purpose, (r).status from (select tests.grant_consent(tests.t('gv')) r) s $$,
  $$ values ('sms', 'transactional', 'granted') $$, 'AC1: a valid hash grants a transactional consent');
select tests.as_postgres();
select results_eq($$ select c.source, c.consent_text_version, c.consent_text_hash = tests.expected_hash('sms'), c.locale
  from app.consents c join app.visits v on v.contact_id = c.contact_id where v.guest_token_hash = private.token_hash(tests.t('gv')) $$,
  $$ values ('online', '2', true, 'en') $$, 'AC1: the consent stores version 2, the hash and the locale');
select tests.as_anon();
select lives_ok($$ select tests.grant_consent(tests.t('gv')) $$, 'a repeat is a no-op');
select tests.as_postgres();
select is((select count(*)::int from app.consents c join app.visits v on v.contact_id = c.contact_id where v.guest_token_hash = private.token_hash(tests.t('gv'))), 1, 'one consent row after a repeat');

-- AC2
select tests.as_anon();
select throws_ok($$ select tests.grant_consent(tests.t('gv'), 'whatsapp', 1, repeat('0', 64)) $$, 'P0001', 'consent_text_mismatch', 'AC2: a wrong hash is rejected');
select throws_ok($$ select tests.grant_consent(tests.t('gv'), 'sms', 3, repeat('0', 64)) $$, 'P0001', 'consent_text_mismatch', 'an unpublished version is a mismatch');
select throws_ok($$ select tests.grant_consent(tests.t('gv'), 'sms', 1, (select h from tests.v1_hash)) $$, 'P0001', 'consent_text_mismatch', 'a page still showing v1 cannot grant: superseded words');
select tests.as_postgres();
select is((select count(*)::int from app.consents where channel = 'whatsapp' and contact_id in (select contact_id from app.visits where guest_token_hash = private.token_hash(tests.t('gv')))), 0, 'AC2: no row for the rejected call');

-- AC3
select tests.as_anon();
select throws_ok($$ select tests.grant_consent('nope') $$, 'P0001', 'not_found', 'AC3: an unknown token is not_found');
select throws_ok($$ select api.get_visit_status('nope') $$, 'P0001', 'not_found', 'AC3: the same code as get_visit_status');
select throws_ok($$ select tests.grant_consent(tests.t('gv_nophone')) $$, 'P0001', 'not_found', 'an ended visit is not_found');
select results_eq($$ select (r).channel, (r).purpose, (r).status from (select tests.grant_consent(tests.t('gv_b')) r) s $$,
  $$ values ('sms', 'transactional', 'granted') $$, 'an opted-out number gets the same answer as a grant (no oracle)');
select throws_ok($$ select tests.grant_consent(tests.t('gv'), 'push') $$, 'P0001', 'invalid_input', 'only sms and whatsapp');

select results_eq($$ select (r).channel, (r).purpose, (r).status from (select tests.grant_consent(tests.t('gv_known')) r) s $$,
  $$ values ('sms', 'transactional', 'granted') $$, 'a typed number the org already holds gets the same answer as a grant (no oracle)');
select tests.as_postgres();
select is((select count(*)::int from app.consents where contact_id = tests.id('contact_a')), 1, 'but no consent was written for that contact (only the fixture one)');
select is((select contact_id from app.visits where guest_token_hash = private.token_hash(tests.t('gv_known'))), null, 'and the visit was not attached to the held contact');
select is((select count(*)::int from private.consent_claims c join app.visits v on v.id = c.visit_id
           where v.guest_token_hash = private.token_hash(tests.t('gv_known'))), 1, 'the claim is recorded so the status page agrees');
select is((select (api.get_visit_status(tests.t('gv_known'))).text_consent), 'on', 'text_consent reads on, as after a real grant');
select is((select (api.get_visit_status(tests.t('gv'))).text_consent), 'on', 'and the real grant reads on too');
-- Repeating the call: a held number and a real grant both give the same row every time.
select tests.as_anon();
select is((select tests.grant_consent(tests.t('gv_known'))::text), (select tests.grant_consent(tests.t('gv_known'))::text), 'a held answer repeats verbatim');
select is((select tests.grant_consent(tests.t('gv'))::text), (select tests.grant_consent(tests.t('gv'))::text), 'and so does a real one');
select tests.as_postgres();
-- A wrong hash is the same error whether or not the number is held.
select tests.as_anon();
select throws_ok($$ select tests.grant_consent(tests.t('gv_known'), 'sms', 2, repeat('0', 64)) $$, 'P0001', 'consent_text_mismatch', 'a wrong hash on a held number is consent_text_mismatch');
select tests.as_anon();

-- AC4: the token alone decides the org; there is no other parameter to point elsewhere.
select tests.as_postgres();
select is((select count(*)::int from app.consents where org_id <> tests.id('org_a') and consent_text_version = '2'), 0, 'AC4: nothing was written for another org');

-- AC5
select tests.act_as('owner');
select throws_ok($$ update app.consent_texts set body = 'x' $$, '42501', null, 'AC5: published copy cannot be updated');
select throws_ok($$ delete from app.consent_texts $$, '42501', null, 'AC5: nor deleted, even by an owner');

-- Rate limit: 10 per hour per token.
select tests.as_postgres();
select tests.as_anon();
select tests.join_as('rv', '+14155550166');
select count(tests.grant_consent(tests.t('rv'), 'sms')) from generate_series(1, 10);
select throws_ok($$ select tests.grant_consent(tests.t('rv'), 'sms') $$, 'P0001', 'rate_limited', 'the 11th call within an hour is rate limited');

-- Per device: many visits from one device share a budget of 20 calls an hour.
select tests.as_postgres();
update app.visits set device_key_hash = '\x01'::bytea where guest_token_hash = private.token_hash(tests.t('rv'));
insert into private.consent_attempts (visit_id, device_hash) select gen_random_uuid(), '\x01'::bytea from generate_series(1, 19);
select tests.as_anon();
select throws_ok($$ select tests.grant_consent(tests.t('rv'), 'sms') $$, 'P0001', 'rate_limited', 'the visit is already over its own limit');
select tests.as_postgres();
delete from private.consent_attempts where visit_id = (select id from app.visits where guest_token_hash = private.token_hash(tests.t('rv')));
select tests.as_anon();
select tests.join_as('dv', '+14155550167');
select tests.as_postgres();
update app.visits set device_key_hash = '\x01'::bytea where guest_token_hash = private.token_hash(tests.t('dv'));
select tests.as_anon();
select lives_ok($$ select tests.grant_consent(tests.t('dv'), 'sms') $$, 'the 20th call from a device passes');
select throws_ok($$ select tests.grant_consent(tests.t('dv'), 'sms') $$, 'P0001', 'rate_limited', 'the 21st call from one device is rate limited, across visits');

-- Per network: 120 calls an hour from one address, across visits.
select tests.as_postgres();
insert into private.consent_attempts (visit_id, ip_hash)
  select gen_random_uuid(), sha256(convert_to('203.0.113.9', 'UTF8')) from generate_series(1, 120);
select tests.as_anon();
select tests.join_as('nv', '+14155550168');
select set_config('request.headers', '{"x-real-ip": "203.0.113.9"}', true);
select throws_ok($$ select tests.grant_consent(tests.t('nv'), 'sms') $$, 'P0001', 'rate_limited', 'the 121st call from one network is rate limited');
select set_config('request.headers', '{"x-real-ip": "203.0.113.10"}', true);
select lives_ok($$ select tests.grant_consent(tests.t('nv'), 'sms') $$, 'another network is unaffected');

select * from finish();
rollback;
