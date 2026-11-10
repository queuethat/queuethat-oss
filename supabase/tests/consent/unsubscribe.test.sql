-- 3-EM3 (#349): marketing unsubscribe withdraws marketing consent only; marketing rows carry the
-- sender identity the footer needs.
begin;
\ir ../helpers/_setup.psql
select plan(7);
select tests.create_world();
update app.locations set tz = (select name from pg_timezone_names where extract(hour from now() at time zone name) = 12 and name !~ '^(posix|Etc|SystemV)' limit 1); -- a clock inside the send window (08:00-20:00), whatever time CI runs

update app.organizations set legal_name = 'Acme Ltd', postal_address = '1 Main St' where id = tests.id('org_a');
insert into app.guests (id, org_id, first_name) values (tests.new_id('guest_b'), tests.id('org_b'), 'Bea');
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('contact_e'), tests.id('org_a'), tests.id('guest_a'), 'email', 'lee@example.com', 'online'),
       (tests.new_id('contact_o'), tests.id('org_b'), tests.id('guest_b'), 'email', 'lee@example.com', 'online');
insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash)
values (tests.id('org_a'), tests.new_id('contact_e'), 'email', 'marketing', 'granted', 'online', 'v1', 'h'),
       (tests.id('org_b'), tests.new_id('contact_o'), 'email', 'marketing', 'granted', 'online', 'v1', 'h');
update app.notification_templates set category = 'marketing'
where org_id is null and trigger = 'broadcast' and channel = 'email';

create function tests.enqueue(p_org text, p_visit text, p_contact text, p_category app.message_category, p_key text, p_trigger text)
returns void language sql as $$
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category, dedupe_key)
  values (tests.id(p_org), tests.id(p_visit), 'email', tests.id(p_contact), p_trigger, 1, p_category, p_key)
$$;
select tests.enqueue('org_a', 'visit_a', 'contact_e', 'marketing', 'e1', 'broadcast');

select is((select j.vars ->> 'org_postal_address' from api.claim_outbox(200, 60) j where j.id = (select id from app.notifications where dedupe_key = 'e1')),
  '1 Main St', 'a marketing row carries the postal address');

select tests.as_service();
select api.unsubscribe_outbox((select id from app.notifications where dedupe_key = 'e1'));
select api.unsubscribe_outbox((select id from app.notifications where dedupe_key = 'e1'));
select tests.as_postgres();

select is((select status from app.consents where contact_id = tests.new_id('contact_e') and purpose = 'marketing'), 'revoked',
  'AC2: the contact''s marketing consent is revoked');
select is((select revoked_via from app.consents where contact_id = tests.new_id('contact_e') and purpose = 'marketing'), 'unsubscribe_link',
  'and says how');
select is((select count(*)::int from app.suppressions where value = 'lee@example.com'), 0, 'no address suppression is added, so transactional mail continues');

select tests.enqueue('org_a', 'visit_a', 'contact_e', 'marketing', 'e3', 'broadcast');
select is((select error_code from app.notifications where dedupe_key = 'e3'), 'no_marketing_consent',
  'AC2: the next marketing send is suppressed');
select tests.enqueue('org_a', 'visit_a', 'contact_e', 'transactional', 'e4', 'called');
select is((select status::text from app.notifications where dedupe_key = 'e4'), 'queued',
  'AC4: a called email still queues after a marketing unsubscribe');

select is((select status from app.consents where contact_id = tests.new_id('contact_o') and purpose = 'marketing'), 'granted',
  'another org''s consent for the same address is untouched');

select * from finish();
rollback;
