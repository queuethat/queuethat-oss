-- #986: SMS code verification of a guest's phone: hashed code, expiry, tries, limits, replay, cross-org.
begin;
\ir ../helpers/_setup.psql
select plan(25);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
create table tests.tokens (name text primary key, token text);
grant all on tests.tokens to anon, authenticated;
create function tests.join_as(p_queue text, p_name text, p_phone text) returns void language sql as $$
  insert into tests.tokens
  select p_name, (api.join_queue(tests.id(p_queue), null, p_name, p_phone, null, 1, 'en', gen_random_uuid())).token
$$;
grant execute on function tests.join_as(text, text, text) to anon;
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Walk-ins B', 'B');
select tests.as_anon();
select tests.join_as('queue_a', 'pv', '+14155550188');
select tests.join_as('queue_a', 'pv2', '+14155550177');
select tests.join_as('queue_a', 'pv_noconsent', '+14155550166');
select tests.join_as('queue_a', 'pv_known', '+14155550123');   -- held by contact_a
select tests.join_as('queue_b', 'pv_b', '+14155550188');       -- same number, other org
select tests.as_postgres();
create function tests.t(p text) returns text language sql security definer as $$ select token from tests.tokens where name = p $$;
grant execute on function tests.t(text) to anon, authenticated;
create function tests.consent(p text) returns void language sql security definer as $$
  select api.guest_grant_consent(tests.t(p), 'sms', 2, encode(sha256(convert_to(private.render_consent_text(
    (select location_id from app.visits where guest_token_hash = private.token_hash(tests.t(p))), 'sms', 'transactional', 'en', 2), 'UTF8')), 'hex'), 'en')
$$;
-- public-join calls the request with the service role; the helper stands in for it
create function tests.req(p_token text) returns api.phone_verification language sql security definer as $$
  select api.guest_request_phone_code(p_token) $$;
grant execute on function tests.req(text) to anon, authenticated;
create function tests.code(p text) returns text language sql security definer as $$
  select n.vars ->> 'code' from app.notifications n join app.visits v on v.id = n.visit_id
  where v.guest_token_hash = private.token_hash(tests.t(p)) and n.template_key = 'reply_verify' order by n.created_at desc limit 1
$$;
grant execute on function tests.consent(text), tests.code(text) to anon, authenticated;
select tests.as_anon();
select tests.consent('pv'); select tests.consent('pv2'); select tests.consent('pv_known');
select tests.as_postgres();
-- texts are switched on for both orgs
insert into app.provider_settings (org_id, channel, provider, mode, config, enabled, verified_at) values
  (tests.id('org_a'), 'sms', 'twilio', 'own', '{}', true, now()), (tests.id('org_b'), 'sms', 'twilio', 'own', '{}', true, now())
on conflict (org_id, channel) do update set enabled = true;

-- a code is sent through the outbox and stored only as a hash
select tests.as_anon();
select is((select (r).state from (select tests.req(tests.t('pv')) r) s), 'sent', 'a code is requested');
select tests.as_postgres();
select ok(tests.code('pv') ~ '^[0-9]{6}$', 'a 6-digit code is queued as an sms');
select is((select n.template_key || ':' || n.channel from app.notifications n join app.visits v on v.id = n.visit_id
           where v.guest_token_hash = private.token_hash(tests.t('pv')) and n.template_key = 'reply_verify'), 'reply_verify:sms', 'through the outbox (I-11)');
select is((select count(*)::int from private.phone_codes where code_hash = convert_to(tests.code('pv'), 'UTF8')), 0, 'the plaintext code is not what is stored');

-- resend gap
select tests.as_anon();
select tests.as_anon();
select is((select (r).state from (select tests.req(tests.t('pv')) r) s), 'sent', 'a repeat inside 30 s is the same state');
select tests.as_postgres();
select is((select count(*)::int from app.notifications n join app.visits v on v.id = n.visit_id
           where v.guest_token_hash = private.token_hash(tests.t('pv')) and n.template_key = 'reply_verify'), 1, 'and sends nothing more');

-- wrong code, then right code
select tests.as_anon();
select is((select (r).state from (select api.guest_verify_phone_code(tests.t('pv'), '000000') r) s) , case when tests.code('pv') = '000000' then 'verified' else 'invalid' end, 'a wrong code is invalid');
select is((select (r).state from (select api.guest_verify_phone_code(tests.t('pv2'), tests.code('pv')) r) s), 'invalid', 'another visit cannot use this code');
select is((select (r).state from (select api.guest_verify_phone_code(tests.t('pv_b'), tests.code('pv')) r) s), 'invalid', 'a visit in another org cannot either');
select is((select (r).state from (select api.guest_verify_phone_code(tests.t('pv'), tests.code('pv')) r) s), 'verified', 'the right code verifies');
select tests.as_postgres();
select isnt((select gc.verified_at from app.guest_contacts gc join app.visits v on v.contact_id = gc.id where v.guest_token_hash = private.token_hash(tests.t('pv'))), null, 'the contact is verified');
select is((select count(*)::int from app.guest_contacts where org_id = tests.id('org_b') and verified_at is not null), 0, 'and nothing in the other org');
select is((select count(*)::int from private.phone_codes where visit_id = (select id from app.visits where guest_token_hash = private.token_hash(tests.t('pv')))), 0, 'the code is gone after use');
select tests.as_anon();
select is((select (r).state from (select api.guest_verify_phone_code(tests.t('pv'), tests.code('pv')) r) s), 'verified', 'replaying the code is harmless (already verified)');
select is((select (r).state from (select tests.req(tests.t('pv')) r) s), 'verified', 'asking again for a verified number says verified, sends nothing');

-- brute force: five wrong tries burn the code, even the right one then fails
select tests.req(tests.t('pv2'));
select tests.as_postgres();
update private.phone_codes set last_sent_at = now() - interval '1 minute' where visit_id = (select id from app.visits where guest_token_hash = private.token_hash(tests.t('pv2')));
create function tests.wrong(p text) returns text language sql security definer as $$
  select case when tests.code(p) = '111111' then '222222' else '111111' end $$;
grant execute on function tests.wrong(text) to anon;
select tests.as_anon();
select api.guest_verify_phone_code(tests.t('pv2'), tests.wrong('pv2')) from generate_series(1, 5);
select is((select (r).state from (select api.guest_verify_phone_code(tests.t('pv2'), tests.code('pv2')) r) s), 'invalid', 'after five wrong tries the right code no longer works');

-- expiry
select tests.as_postgres();
update private.phone_codes set tries = 0, expires_at = now() - interval '1 second' where visit_id = (select id from app.visits where guest_token_hash = private.token_hash(tests.t('pv2')));
select tests.as_anon();
select is((select (r).state from (select api.guest_verify_phone_code(tests.t('pv2'), tests.code('pv2')) r) s), 'invalid', 'an expired code is invalid');

-- no consent, unknown token, and a number the org already holds
select throws_ok($$ select tests.req(tests.t('pv_noconsent')) $$, 'P0001', 'consent_required', 'no sms consent, no code');
select throws_ok($$ select tests.req('nope') $$, 'P0001', 'not_found', 'an unknown token is not_found');
select is((select (r).state from (select tests.req(tests.t('pv_known')) r) s), 'sent', 'a held number gets the same answer');
select tests.as_postgres();
select is(tests.code('pv_known'), null, 'but no message is queued for it');

-- per-number daily cap across orgs: the shared number 188 was requested once by pv; fill the rest
insert into private.phone_code_attempts (visit_id, kind, phone_hash) select gen_random_uuid(), 'request', sha256(convert_to('+14155550188', 'UTF8')) from generate_series(1, 4);
select tests.as_anon();
select throws_ok($$ select tests.req(tests.t('pv_b')) $$, 'P0001', 'rate_limited', 'one number can be sent at most five codes a day in total');

select tests.as_postgres();
select tests.as_anon();
select throws_ok($$ select api.guest_verify_phone_code(tests.t('pv'), null) from generate_series(1, 25) $$, 'P0001', 'rate_limited', 'verify attempts are limited per visit');

select tests.as_postgres();
-- the plaintext code does not outlive its message
update app.notifications set status = 'sent', sent_at = now() where template_key = 'reply_verify' and visit_id = (select id from app.visits where guest_token_hash = private.token_hash(tests.t('pv2')));
select is((select vars::text from app.notifications where template_key = 'reply_verify' and visit_id = (select id from app.visits where guest_token_hash = private.token_hash(tests.t('pv2')))), '{}', 'once sent, the queued row no longer holds the code');

select tests.as_anon();
select throws_ok($$ select api.guest_request_phone_code(tests.t('pv')) $$, '42501', null, 'anon cannot request a code directly (the CAPTCHA route is the only way)');
select tests.as_postgres();
select * from finish();
rollback;
