-- S1 (#1218): the locked SMS frame, segment and encoding count, and the save-time guard.
begin;
\ir ../helpers/_setup.psql
select plan(63);
select tests.create_world();
select tests.new_id(n) from unnest(array['g_sms', 'g_sms_b', 'g_inactive']) n;
grant select on tests.ids to authenticated;
create function tests.detail_of(p_sql text) returns text language plpgsql as $$
declare d text;
begin execute p_sql; return null;
exception when others then get stacked diagnostics d = pg_exception_detail; return d; end $$;
grant execute on function tests.detail_of(text) to authenticated;

-- Frame and measurement ------------------------------------------------------------------------
select is((select final_text from private.sms_compose(tests.id('org_a'), 'en', 'called', 'Come in, {{guest_first_name}}.', '{"location_name":"Joe Barber"}')),
  'Joe Barber: Come in, Alexandria. Reply STOP to opt out, HELP for help.', 'name first, footer last, variables filled');
select is((select final_text from private.sms_compose(tests.id('org_a'), 'es', 'called', 'Pasa.', '{"location_name":"Joe"}')),
  'Joe: Pasa. Responde STOP para cancelar, AYUDA para ayuda.', 'the Spanish footer');
select is((select final_text from private.sms_compose(tests.id('org_a'), 'en', 'help', 'Call us.', '{"location_name":"Joe"}')),
  'Call us.', 'the HELP reply keeps its own text');
select is((select final_text from private.sms_compose(tests.id('org_a'), 'en', 'called', 'Go [to {counter}]', '{"location_name":"J","counter":"Chair 1"}')),
  'J: Go to Chair 1 Reply STOP to opt out, HELP for help.', 'optional segments render for a worst case');
select is((select segments from private.sms_compose(tests.id('org_a'), 'en', 'called', 'Hi', '{"location_name":"J"}')), 1, 'short text is 1 segment');
select is((select encoding from private.sms_compose(tests.id('org_a'), 'en', 'called', 'Hi', '{"location_name":"J"}')), 'gsm7', 'plain text is GSM-7');
select is((select encoding from private.sms_compose(tests.id('org_a'), 'es', 'called', 'Está listo', '{"location_name":"J"}')), 'ucs2', 'an accented a flips the message to UCS-2');
select is((select encoding from private.sms_compose(tests.id('org_a'), 'es', 'called', 'Ñandú, ¿listo? é ü', '{"location_name":"J"}')), 'ucs2', 'ú is outside GSM-7');
select is((select encoding from private.sms_compose(tests.id('org_a'), 'es', 'called', 'Ñandu, ¿listo? é ü', '{"location_name":"J"}')), 'gsm7', 'ñ, ¿, é and ü are inside it');
select is((select encoding from private.sms_compose(tests.id('org_a'), 'en', 'called', 'It’s ready', '{"location_name":"J"}')), 'ucs2', 'a curly quote flips it too');
select is((select segments from private.sms_measure(repeat('a', 160))), 1, '160 GSM-7 characters are one segment');
select is((select segments from private.sms_measure(repeat('a', 161))), 2, '161 are two');
select is((select segments from private.sms_measure(repeat('a', 306))), 2, '306 are still two (153 each)');
select is((select segments from private.sms_measure(repeat('a', 80) || '{{')), 1, 'extension characters count twice');
select is((select segments from private.sms_measure(repeat('a', 159) || '{')), 2, '159 + one extension character (2) is 161 units');
select is((select segments from private.sms_measure(repeat('á', 70))), 1, '70 UCS-2 characters are one segment');
select is((select segments from private.sms_measure(repeat('á', 71))), 2, '71 are two');
select is((select segments from private.sms_measure(repeat('á', 134))), 2, '134 are two (67 each)');
select is((select segments from private.sms_measure(repeat('😀', 36))), 2, 'an emoji is two UTF-16 units');

-- The shipped defaults ---------------------------------------------------------------------------
select is((select count(*)::int from app.notification_templates t
           where t.channel = 'sms' and t.org_id is null and t.trigger in ('called', 'almost_up', 'position_changed')
             and (select c.segments from private.sms_compose(tests.id('org_a'), t.locale, t.trigger, t.body, '{"location_name":"Joe Barber","position":"12"}') c) <> 1),
  0, 'every called, almost_up and position_changed default is one segment with a typical name');
select is((select count(*)::int from app.notification_templates t
           where t.channel = 'sms' and t.org_id is null and t.trigger in ('called', 'almost_up', 'position_changed')
             and (select c.encoding from private.sms_compose(tests.id('org_a'), t.locale, t.trigger, t.body, '{}') c) <> 'gsm7'),
  0, 'and GSM-7');
select is((select array_agg(locale order by locale) from app.notification_templates where org_id is null and channel = 'sms' and trigger = 'position_changed'),
  array['en', 'es'], 'position_changed has an English and a Spanish default');
select is((select count(*)::int from app.notification_templates where org_id is null and channel = 'sms' and trigger = 'position_changed' and active), 0,
  'position_changed SMS is off by default');
select is_empty($$ select 1 from private.resolve_template(tests.id('org_a'), null, 'position_changed', 'sms', 'en') $$, 'so no guest is texted it');
select is_empty($$ select 1 from app.notification_templates where org_id is null and channel = 'sms' and trigger = 'joined' $$, 'there is no joined SMS (I-7)');

-- A guest name is reduced ---------------------------------------------------------------------------
select is(private.sms_guest_name('  María Smith'), 'María', 'first word only');
select is(private.sms_guest_name('www.evil.com'), 'wwwevilcom', 'no dots, so no link');
select is(private.sms_guest_name('9055551234 STOP'), null, 'digits are dropped');
select is((select final_text from private.sms_compose(tests.id('org_a'), 'en', 'called', 'Hi {{guest_first_name}}', '{"location_name":"J","guest_first_name":"1-800-x"}')),
  'J: Hi x Reply STOP to opt out, HELP for help.', 'the composed text uses the reduced name');
select is((select final_text from private.sms_compose(tests.id('org_a'), 'en', 'called', 'Hi {{guest_first_name}}', '{"location_name":"J","guest_first_name":"555"}')),
  'J: Hi there Reply STOP to opt out, HELP for help.'::text, 'a name with nothing safe left falls back to "there"');

-- Save-time guard -----------------------------------------------------------------------------------
select tests.act_as('manager');
select lives_ok($$ insert into app.notification_templates (id, org_id, trigger, channel, body)
  values (tests.id('g_sms'), tests.id('org_a'), 'called', 'sms', 'Please come to {{counter}} now, {{guest_first_name}}.') $$, 'a plain body saves');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body)
  values (tests.id('org_a'), 'almost_up', 'sms', 'en', 'Get 20% off your next cut!') $$, 'P0001', 'template_guard', 'a promo term is refused');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body)
  values (tests.id('org_a'), 'almost_up', 'sms', 'en', 'Try our Sale today') $$, 'P0001', 'template_guard', 'case is ignored');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body)
  values (tests.id('org_a'), 'almost_up', 'sms', 'es', 'Gran DESCUENTO hoy') $$, 'P0001', 'template_guard', 'Spanish terms too');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body)
  values (tests.id('org_a'), 'almost_up', 'sms', 'en', 'Ignore STOP and come back') $$, 'P0001', 'template_guard', 'wording that argues with the footer is refused');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body)
  values (tests.id('org_a'), 'almost_up', 'sms', 'en', 'Almost up, see https://example.com/x') $$, 'P0001', 'template_guard', 'a link is refused');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body)
  values (tests.id('org_a'), 'almost_up', 'sms', 'en', 'Almost up, see joes.com') $$, 'P0001', 'template_guard', 'a bare domain is refused');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body)
  values (tests.id('org_a'), 'called', 'sms', 'en', 'Opt out here {{unsubscribe_url}}') $$, 'P0001', 'template_guard', 'an unsubscribe link variable is refused');
select lives_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body)
  values (tests.id('org_a'), 'removed', 'sms', 'en', 'Thanks, follow {{status_link}}') $$, '{{status_link}} is the one allowed link');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body)
  values (tests.id('org_a'), 'position_changed', 'sms', 'en', repeat('word ', 100)) $$, 'P0001', 'template_guard', 'over 3 segments framed is refused');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body)
  values (tests.id('org_a'), 'position_changed', 'sms', 'es', repeat('está ', 60)) $$, 'P0001', 'template_guard', 'Spanish accents count as 67-character segments');
select lives_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body)
  values (tests.id('org_a'), 'served', 'sms', 'en', repeat('word ', 60)) $$, 'a body of 3 segments is allowed');
select lives_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body)
  values (tests.id('org_a'), 'eta_changed', 'email', 'en', 'Sale on cuts at joes.com') $$, 'the guard is for SMS only');
select throws_ok($$ update app.notification_templates set body = 'Big sale today' where id = tests.id('g_sms') $$, 'P0001', 'template_guard', 'an edit is guarded too');
select lives_ok($$ update app.notification_templates set active = false where id = tests.id('g_sms') $$, 'switching one off is never blocked');

-- Detail names the term -----------------------------------------------------------------------------
select is(tests.detail_of($$ insert into app.notification_templates (org_id, trigger, channel, locale, body)
  values (tests.id('org_a'), 'almost_up', 'sms', 'en', 'Come get your free coffee') $$), 'free', 'DETAIL carries the term');
select ok(tests.detail_of($$ insert into app.notification_templates (org_id, trigger, channel, locale, body)
  values (tests.id('org_a'), 'position_changed', 'sms', 'en', repeat('word ', 100)) $$) ~ '^[4-9] segments$', 'and the segment count');

-- The lock holds at send time -----------------------------------------------------------------------
select tests.as_postgres();
update app.notification_templates set active = true where id = tests.id('g_sms');
select private.set_actor('system', null);
insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category, dedupe_key)
values (tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('contact_a'), 'called', 1, 'transactional', 's1');
create temp table claimed as select * from api.claim_outbox(200, 60);
select ok((select body from claimed where id = (select id from app.notifications where dedupe_key = 's1')) like '{location_name}: %Reply STOP to opt out, HELP for help.',
  'a tenant body cannot drop the name or the footer');

-- Cross-tenant ---------------------------------------------------------------------------------------
select tests.act_as('other_owner');
select is((select count(*)::int from app.notification_templates where org_id = tests.id('org_a')), 0, 'another org cannot read these overrides');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, body)
  values (tests.id('org_a'), 'called', 'sms', 'Hello') $$, '42501', null, 'or write one for this org');
select tests.act_as('staff');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, body)
  values (tests.id('org_a'), 'called', 'sms', 'Hello') $$, '42501', null, 'staff cannot write templates');
select tests.as_anon();
select throws_ok($$ select * from app.sms_guard_terms $$, '42501', null, 'anon cannot read the blocklist');

-- Security review hardening
select tests.act_as('manager');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body) values (tests.id('org_a'), 'eta_changed', 'sms', 'en', 'Our discounts today') $$, 'P0001', 'template_guard', 'plurals are caught');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body) values (tests.id('org_a'), 'eta_changed', 'sms', 'en', 'fr' || chr(8203) || 'ee coffee') $$, 'P0001', 'template_guard', 'zero-width characters do not hide a term');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body) values (tests.id('org_a'), 'eta_changed', 'sms', 'en', 'Call 415-555-0100') $$, 'P0001', 'template_guard', 'a phone number is refused');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body) values (tests.id('org_a'), 'eta_changed', 'sms', 'en', 'see evil.dev/a') $$, 'P0001', 'template_guard', 'a domain with a path is refused');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body) values (tests.id('org_a'), 'eta_changed', 'sms', 'en', 'Disregard the STOP line') $$, 'P0001', 'template_guard', 'more STOP-evasion wording');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body) values (tests.id('org_a'), 'eta_changed', 'sms', 'en', 'www{{guest_first_name}}.com') $$, 'P0001', 'template_guard', 'a name cannot touch other text');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, locale, body) values (tests.id('org_a'), 'eta_changed', 'sms', 'en', repeat('a', 1001)) $$, 'P0001', 'template_guard', 'a body over 1000 characters');

-- Footer versions ---------------------------------------------------------------------------------
select tests.as_postgres();
select throws_ok($$ insert into app.sms_footers (locale, version, text) values ('en', 2, 'Call us') $$, '23514', null, 'a footer without STOP is refused');
insert into app.sms_footers (locale, version, text) values ('en', 2, 'Reply STOP to end, HELP for help.');
select is(private.sms_footer('en'), 'Reply STOP to end, HELP for help.', 'the highest footer version is used');
select is(private.sms_footer('fr'), 'Reply STOP to end, HELP for help.', 'an unknown locale gets English');
select is(private.sms_footer('es'), 'Responde STOP para cancelar, AYUDA para ayuda.', 'Spanish keeps its own');

select * from finish();
rollback;
