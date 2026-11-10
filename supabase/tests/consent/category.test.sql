-- 3-CG7 (#332): marketing messages need marketing consent and never ride visit-event triggers.
begin;
\ir ../helpers/_setup.psql
select plan(10);
select tests.create_world();
update app.locations set tz = (select name from pg_timezone_names where extract(hour from now() at time zone name) = 12 and name !~ '^(posix|Etc|SystemV)' limit 1); -- a clock inside the send window (08:00-20:00), whatever time CI runs

-- contact_a (fixture) has transactional SMS consent only; a second one also granted marketing.
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('contact_m'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550124', 'online');
insert into app.consents (id, org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash)
values (tests.new_id('consent_m'), tests.id('org_a'), tests.id('contact_m'), 'sms', 'marketing', 'granted', 'online', 'v1', 'h');
-- The system default broadcast_marketing sms template (category marketing) is seeded by the migration.

create function tests.enqueue(p_contact text, p_category app.message_category, p_key text, p_trigger text default 'broadcast_marketing')
returns void language sql as $$
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category, dedupe_key)
  values (tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id(p_contact), p_trigger, 1, p_category, p_key)
$$;

-- AC1: transactional-only consent -> stored suppressed, never sent.
select tests.enqueue('contact_a', 'marketing', 'm1');
select results_eq($$ select status::text, error_code from app.notifications where dedupe_key = 'm1' $$,
  $$ values ('suppressed', 'no_marketing_consent') $$, 'AC1: marketing without marketing consent is suppressed');
select is((select count(*)::int from app.notifications where dedupe_key = 'm1' and status in ('queued', 'claimed')), 0,
  'AC1: it is not claimable by the dispatcher');

-- With marketing consent it queues.
select tests.enqueue('contact_m', 'marketing', 'm2');
select is((select status::text from app.notifications where dedupe_key = 'm2'), 'queued', 'marketing consent lets it queue');

-- AC2: revoked after enqueue -> claim reports no consent.
update app.consents set status = 'revoked', revoked_at = now() where id = tests.new_id('consent_m');
select is((select j.has_consent from api.claim_outbox(200, 60) j where j.id = (select id from app.notifications where dedupe_key = 'm2')),
  false, 'AC2: a revoked marketing consent reaches the dispatcher as no consent');
select tests.enqueue('contact_m', 'marketing', 'm3');
select is((select error_code from app.notifications where dedupe_key = 'm3'), 'no_marketing_consent', 'a revoked consent also suppresses new rows');

-- Transactional is unaffected.
select tests.enqueue('contact_a', 'transactional', 'm4', 'almost_up');
select is((select status::text from app.notifications where dedupe_key = 'm4'), 'queued', 'transactional still queues');

-- Category must match the template.
select throws_ok($$ select tests.enqueue('contact_a', 'transactional', 'm6', 'broadcast_marketing') $$, 'P0001', 'category_mismatch',
  'a row whose category differs from every matching template is rejected');

-- AC3: marketing templates cannot be bound to visit-event triggers.
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, category, body)
  values (null, 'called', 'sms', 'marketing', 'x') $$, '23514', null, 'AC3: a marketing template on called is rejected');
select throws_ok($$ update app.notification_templates set category = 'marketing' where trigger = 'almost_up' and org_id is null $$,
  '23514', null, 'AC3: nor can a default be flipped to marketing');

-- AC4: org B cannot write org A's outbox.
select tests.act_as('other_owner');
select throws_ok($$ select tests.enqueue('contact_m', 'marketing', 'x1') $$, '42501', null, 'AC4: org B cannot enqueue for an org A contact');

select * from finish();
rollback;
