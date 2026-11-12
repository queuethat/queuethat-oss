-- S2 (#1219): api.sms_preview shows the locked frame, the tenant's middle and the measure, from the database.
begin;
\ir ../helpers/_setup.psql
select plan(16);
select tests.create_world();

select tests.act_as('staff');
select is((select prefix from api.sms_preview(tests.id('org_a'), 'called', 'en', 'Come in.')), 'Location A: ',
  'the prefix is the business name (the longest of the org and location names)');
select is((select body from api.sms_preview(tests.id('org_a'), 'called', 'en', 'Come in.')), 'Come in.', 'the middle is the draft');
select is((select footer from api.sms_preview(tests.id('org_a'), 'called', 'en', 'Come in.')), 'Reply STOP to opt out, HELP for help.',
  'the footer is the latest English opt-out line');
select is((select footer from api.sms_preview(tests.id('org_a'), 'called', 'es', 'Pasa.')), 'Responde STOP para cancelar, HELP para ayuda.',
  'the Spanish footer for es');
select is((select source from api.sms_preview(tests.id('org_a'), 'called', 'en', 'Come in.')), 'draft', 'a typed body is a draft');
select is((select body from api.sms_preview(tests.id('org_a'), 'called', 'en', 'Hi {{guest_first_name}}, {ticket}.')), 'Hi Alexandria, A-123.',
  'variables take the long stand-ins');
select is((select (segments, encoding)::text from api.sms_preview(tests.id('org_a'), 'called', 'es', 'Está listo')),
  (select (segments, encoding)::text from private.sms_compose(tests.id('org_a'), 'es', 'called', 'Está listo', '{}')),
  'segments and encoding are the frame''s own measure');

-- The preview is the text the outbox claims (private.sms_compose(body, locale) with the business name filled).
select is((select prefix || body || ' ' || footer from api.sms_preview(tests.id('org_a'), 'almost_up', 'en', 'Head back now.')),
  replace(private.sms_compose('Head back now.', 'en'), '{location_name}', 'Location A'),
  'prefix, middle and footer join into the claimed text');

-- With no body: what the locale resolves to.
select is((select (source, body)::text from api.sms_preview(tests.id('org_a'), 'almost_up', 'en')),
  '(default,"You''re almost up (A-123). Please head back now.")', 'no override: the system default');
select is_empty($$ select 1 from api.sms_preview(tests.id('org_a'), 'position_changed', 'en') $$,
  'an inactive default gives no row');
select tests.act_as('manager');
insert into app.notification_templates (org_id, trigger, channel, locale, body)
values (tests.id('org_a'), 'almost_up', 'sms', 'en', 'Nearly you, {ticket}.');
select is((select (source, body)::text from api.sms_preview(tests.id('org_a'), 'almost_up', 'en')),
  '(custom,"Nearly you, A-123.")', 'the English override');
select is((select (source, body)::text from api.sms_preview(tests.id('org_a'), 'almost_up', 'es')),
  '(custom_other_locale,"Nearly you, A-123.")', 'a Spanish guest gets the English override, and the preview says so');
insert into app.notification_templates (org_id, trigger, channel, locale, body)
values (tests.id('org_a'), 'almost_up', 'sms', 'es', 'Casi es tu turno, {ticket}.');
select is((select (source, footer)::text from api.sms_preview(tests.id('org_a'), 'almost_up', 'es')),
  '(custom,"Responde STOP para cancelar, HELP para ayuda.")', 'the Spanish override once there is one');

-- Who may call it.
select tests.act_as('other_owner');
select throws_ok($$ select * from api.sms_preview(tests.id('org_a'), 'called', 'en', 'x') $$, '42501', 'permission_denied',
  'another org''s owner cannot preview (cross-tenant)');
select tests.as_anon();
select throws_ok($$ select * from api.sms_preview(tests.id('org_a'), 'called', 'en', 'x') $$, '42501', null, 'anon cannot execute it');
select tests.as_postgres();
select ok(not has_function_privilege('anon', 'api.sms_preview(uuid, text, text, text)', 'execute'), 'no anon grant');

select * from finish();
rollback;
