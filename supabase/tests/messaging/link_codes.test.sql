-- N2 (#252): Telegram link codes, redemption and /stop.
begin;
\ir ../helpers/_setup.psql
select plan(18);
select tests.create_world();
update app.locations set tz = (select name from pg_timezone_names where extract(hour from now() at time zone name) = 12 and name !~ '^(posix|Etc|SystemV)' limit 1); -- a clock inside the send window (08:00-20:00), whatever time CI runs

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
select vault.create_secret('qm_test_bot', 'telegram_bot_username', 'test bot');
create table tests.tokens (name text primary key, token text);
create table tests.codes (name text primary key, code text);
grant select on all tables in schema tests to anon, authenticated, service_role;
grant insert on tests.tokens, tests.codes to anon, service_role;

select tests.as_anon();
insert into tests.tokens select 'ann', (api.join_queue(tests.id('queue_a'), null, 'Ann', null, null, 1, null, gen_random_uuid())).token;
insert into tests.codes
select 'c1', split_part((api.guest_create_link_code((select token from tests.tokens where name = 'ann'), 'telegram')).deep_link, '?start=', 2);
select tests.as_postgres();

select is((select count(*)::int from tests.codes where length(code) = 24), 1, 'a code is 24 url-safe characters');
select is((select count(*)::int from app.channel_link_codes where code_hash = extensions.digest((select code from tests.codes), 'sha256')), 1,
  'only the hash is stored');
select is((select count(*)::int from app.channel_link_codes where encode(code_hash, 'escape') = (select code from tests.codes)), 0,
  'the code itself is not stored');

select tests.as_anon();
select throws_ok($$ select api.guest_create_link_code((select token from tests.tokens where name = 'ann'), 'sms') $$,
  'P0001', 'invalid_input', 'only telegram links exist');
select throws_ok($$ select api.guest_create_link_code('no-such-token', 'telegram') $$,
  'P0001', 'not_found', 'a wrong token is not_found');
select throws_ok($$ select api.redeem_link_code((select code from tests.codes), '555') $$,
  '42501', null, 'anon cannot redeem');
select tests.as_user(tests.id('owner'));
select throws_ok($$ select api.redeem_link_code((select code from tests.codes), '555') $$,
  '42501', null, 'a signed-in staff member cannot redeem');

select tests.as_service();
select is((select (api.redeem_link_code('not-a-real-code-1234', '555')).linked), false, 'an unknown code links nothing');
select is((select (api.redeem_link_code((select code from tests.codes), '555')).linked), true, 'a valid code links');
select tests.as_postgres();
select results_eq($$ select org_id, channel::text, value from app.guest_contacts where channel = 'telegram' $$,
  $$ values (tests.id('org_a'), 'telegram', 'tg:555') $$, 'the contact carries the visit''s org only');
select results_eq($$ select c.org_id, c.status, c.source from app.consents c join app.guest_contacts g on g.id = c.contact_id where g.value = 'tg:555' $$,
  $$ values (tests.id('org_a'), 'granted', 'telegram_start') $$, 'a transactional consent with the telegram_start source exists');
select private.enqueue_notification((select v from app.visits v where v.guest_token_hash = private.token_hash((select token from tests.tokens where name = 'ann'))), null, 'almost_up', 'tg-link');
select results_eq($$ select channel::text, recipient_ref from app.notifications where dedupe_key like 'tg-link:%' and channel = 'telegram' $$,
  $$ select 'telegram', id from app.guest_contacts where value = 'tg:555' $$, 'a linked chat is a recipient of the visit''s messages');
select tests.as_service();
select is((select (api.redeem_link_code((select code from tests.codes), '555')).linked), false, 'a used code links nothing again');

-- Expired codes fail the same way.
select tests.as_postgres();
update app.channel_link_codes set used_at = null, expires_at = now() - interval '1 second';
select tests.as_service();
select is((select (api.redeem_link_code((select code from tests.codes), '556')).linked), false, 'an expired code links nothing');
select tests.as_postgres();
select is((select count(*)::int from app.guest_contacts where value = 'tg:556'), 0, '... and creates no contact');

-- /stop revokes consent and suppresses the chat; the next dispatch sees it suppressed.
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
select tests.new_id('n_tg'), tests.id('org_a'), (select visit_id from app.channel_link_codes limit 1), 'telegram',
       (select id from app.guest_contacts where value = 'tg:555'), 'almost_up', 1, 'tg-stop';
select tests.as_service();
select is(api.unlink_telegram_chat('555'), 1, '/stop revokes the chat''s consent');
select is(api.unlink_telegram_chat('555'), 0, '... and repeating it changes nothing');
select tests.as_postgres();
select is((select (j.has_consent, j.is_suppressed)::text from api.claim_outbox(10, 60) j where j.id = tests.id('n_tg')), '(f,t)',
  'the next dispatch has no consent and the chat is suppressed');

select * from finish();
rollback;
