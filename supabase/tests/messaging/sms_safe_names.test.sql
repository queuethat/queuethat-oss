-- #1247: tenant- and guest-typed names reach an SMS only as plain names, decided in the database.
begin;
\ir ../helpers/_setup.psql
select plan(33);
select tests.create_world();

-- Plain names pass; anything else becomes the fallback -------------------------------------------------
select is(private.sms_safe_label('Joe''s Barber & Co', 'F'), 'Joe''s Barber & Co', 'a plain name passes');
select is(private.sms_safe_label('Café Ñandú #2 (Main)', 'F'), 'Café Ñandú #2 (Main)', 'accents, #, parentheses pass');
select is(private.sms_safe_label('Joe’s Barber', 'F'), 'Joe''s Barber', 'a curly apostrophe becomes a straight one');
select is(private.sms_safe_label('Joe Barber www.joes.example/promo', 'F'), 'F', 'a link is refused');
select is(private.sms_safe_label('Joes.com Barbers', 'F'), 'F', 'a domain is refused');
select is(private.sms_safe_label('Acme.xyzzy Barber', 'F'), 'F', 'a dotted token on an unlisted tld is refused too');
select is(private.sms_safe_label('Ｊｏｅｓ．ｃｏｍ', 'F'), 'F', 'fullwidth forms fold before the check');
select is(private.sms_safe_label('Joe 50% off today', 'F'), 'F', 'a promo term is refused');
select is(private.sms_safe_label('Joe: Free haircuts', 'F'), 'F', 'free is a promo term');
select is(private.sms_safe_label('Call 905 555 1234', 'F'), 'F', 'a phone number is refused');
select is(private.sms_safe_label('joe@joes.example', 'F'), 'F', 'an address is refused');
select is(private.sms_safe_label('Joe {{status_link}}', 'F'), 'F', 'placeholder braces are refused');
select is(private.sms_safe_label('   ', 'F'), 'F', 'blank gives the fallback');
select is(length(private.sms_safe_label(repeat('Joe ', 30), 'F')), 39, 'a long name is trimmed to 40 characters');

-- The vars of an SMS row --------------------------------------------------------------------------------
select is(private.sms_safe_vars('{"location_name":"Shop - 50% off","queue_name":"Join at x.com","counter":"Desk 2","guest_first_name":"www.evil.com"}', 'en', 'Joe Barber'),
  '{"location_name":"Joe Barber","queue_name":"the queue","counter":"Desk 2","guest_first_name":"wwwevilcom"}'::jsonb,
  'bad names fall back (location to the org name), good ones stay, the guest name is reduced');
select is(private.sms_safe_vars('{"location_name":"bit.ly/x","queue_name":"q"}', 'es', 'promo shop'), '{"location_name":"QueueThat","queue_name":"q"}'::jsonb,
  'with no safe org name the sender is QueueThat');
select is(private.sms_safe_vars('{"business_phone":"http://x.example","support_contact":"see x.com"}', 'en', 'J') ,
  '{"support_contact":"support@queuethat.com"}'::jsonb, 'a link is no phone number or contact');
select is(private.sms_safe_vars('{"business_phone":"+1 (415) 555-0100","support_contact":"help@joes.com"}', 'en', 'J'),
  '{"business_phone":"+1 (415) 555-0100","support_contact":"help@joes.com"}'::jsonb, 'a phone number and one address pass');

-- The claim applies it ------------------------------------------------------------------------------------
update app.locations set name = 'Joe - 50% off at joes.example' where id = tests.id('loc_a');
update app.queues set name = 'Visit joes.example' where id = (select queue_id from app.visits where id = tests.id('visit_a'));
select private.set_actor('system', null);
insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category, dedupe_key, vars) values
  (tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('contact_a'), 'called', 1, 'transactional', 'n1',
   '{"guest_first_name":"1-800-x.com","counter":"call 4155550100 now","queue_name":"Visit joes.example"}'),
  (tests.id('org_a'), tests.id('visit_a'), 'email', tests.id('contact_a'), 'called', 1, 'transactional', 'n2',
   '{"counter":"Visit joes.example"}');
create temp table claimed as select * from api.claim_outbox(200, 60);
select is((select (vars ->> 'location_name') from claimed where id = (select id from app.notifications where dedupe_key = 'n1')),
  (select name from app.organizations where id = tests.id('org_a')), 'an SMS never carries a link as the business name; it takes the org name');
select is((select vars ->> 'guest_first_name' from claimed where id = (select id from app.notifications where dedupe_key = 'n1')), 'xcom', 'the guest name is reduced at the claim');
select is((select vars ->> 'counter' from claimed where id = (select id from app.notifications where dedupe_key = 'n1')), 'the front desk', 'a counter that is a phone number falls back');
select is((select vars ->> 'queue_name' from claimed where id = (select id from app.notifications where dedupe_key = 'n1')), 'the queue', 'and a queue that is a link');
select is((select vars ->> 'counter' from claimed where id = (select id from app.notifications where dedupe_key = 'n2')), 'Visit joes.example', 'email is untouched: names are shown as typed there');

-- Review findings: digits, homoglyphs, accents, other tenant text, placeholders ------------------------------------
select is(private.sms_safe_label('415/555/0100', 'F'), 'F', 'a phone number split by slashes is refused');
select is(private.sms_safe_label('415,555,0100', 'F'), 'F', 'or by commas');
select is(private.sms_safe_label('1-800-FLOWERS', 'F'), 'F', 'a vanity toll-free number is refused');
select is(private.sms_safe_label('Studio 54', 'F'), 'Studio 54', 'a few digits are fine');
select is(private.sms_safe_label('Fr' || chr(235) || 'e haircuts', 'F'), 'F', 'an accented promo word is still a promo word');
select is(private.sms_safe_label('Fr' || chr(1077) || 'e cuts', 'F'), 'F', 'a Cyrillic lookalike is outside the name characters');
select is(private.sms_safe_vars('{"service":"Cut - 50 off at joes.example","event_title":"Plain Event","ticket":"A-1"}', 'en', 'J'),
  '{"service":"your visit","event_title":"Plain Event","ticket":"A-1"}'::jsonb, 'service and event names are names too; system values pass');
select is(private.sms_safe_vars('{"guest_first_name":"FREE"}', 'en', 'J'), '{"guest_first_name":"there"}'::jsonb, 'a guest name that is a promo word falls back');
select tests.act_as('manager');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body)
  values (tests.id('org_a'), 'called', 'sms', 'en', 'Visit {{location_name}}.com/deal') $$, 'P0001', 'template_guard', 'a name followed by .com is refused');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body)
  values (tests.id('org_a'), 'called', 'sms', 'en', 'Go {{queue_name}}{{counter}}') $$, 'P0001', 'template_guard', 'two names run together are refused');
select * from finish();
rollback;
