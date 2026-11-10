-- 2P-NTF5 (#177): template versions, write policy, variable validation and resolution order.
begin;
\ir ../helpers/_setup.psql
select plan(31);
select tests.create_world();
select tests.new_id(n) from unnest(array['t_sms', 'sys_fr', 'sys_en', 'org_en', 'org_fr', 'q_fr']) n;
grant select on tests.ids to authenticated;
create function tests.changed(p_sql text) returns int language plpgsql as $$
declare n int;
begin execute p_sql; get diagnostics n = row_count; return n; end $$;
grant execute on function tests.changed(text) to authenticated;

------------------------------------------------------------------------------------------------
-- Validation (AC1)
------------------------------------------------------------------------------------------------
select tests.act_as('manager');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, body)
  values (tests.id('org_a'), 'called', 'sms', 'Hi {{last_name}}') $$,
  'P0001', 'unknown_variable', 'AC1: {{last_name}} is rejected');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, body)
  values (tests.id('org_a'), 'called', 'sms', 'Hi {last_name}') $$,
  'P0001', 'unknown_variable', 'the legacy single-brace form is checked too');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, subject, body)
  values (tests.id('org_a'), 'called', 'email', '{{secret}}', 'ok {{ticket}}') $$,
  'P0001', 'unknown_variable', 'subjects are checked');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, body)
  values (tests.id('org_a'), 'broadcast', 'sms', 'x {{ticket {unsubscribe_url}}}') $$,
  'P0001', 'unknown_variable', 'a variable hidden inside a malformed placeholder is still caught');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, body)
  values (tests.id('org_a'), 'called', 'sms', 'x {{ticket') $$,
  'P0001', 'unknown_variable', 'an unterminated {{ is rejected');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, body, category)
  values (tests.id('org_a'), 'called', 'sms', 'Sale!', 'marketing') $$,
  'P0001', 'invalid_category', 'marketing templates are not editable');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, body)
  values (tests.id('org_a'), 'support.break_glass', 'email', 'x') $$,
  'P0001', 'invalid_trigger', 'account mail wording is not overridable');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, body)
  values (tests.id('org_a'), 'broadcast', 'sms', 'Late {{counter}}') $$,
  'P0001', 'unknown_variable', 'broadcast allows only ticket and eta_range');

------------------------------------------------------------------------------------------------
-- Versions (AC2)
------------------------------------------------------------------------------------------------
insert into app.notification_templates (id, org_id, trigger, channel, body)
values (tests.id('t_sms'), tests.id('org_a'), 'called', 'sms', 'Go to {{counter}}, {{guest_first_name}}.');
select is((select version from app.notification_templates where id = tests.id('t_sms')), 1, 'a new override is version 1');
update app.notification_templates set body = 'Now serving {{ticket}}' where id = tests.id('t_sms');
select is((select version from app.notification_templates where id = tests.id('t_sms')), 2, 'AC2: an edit increments the version');
update app.notification_templates set body = body where id = tests.id('t_sms');
select is((select version from app.notification_templates where id = tests.id('t_sms')), 2, 'saving unchanged text does not');
update app.notification_templates set version = 1 where id = tests.id('t_sms');
select is((select version from app.notification_templates where id = tests.id('t_sms')), 2, 'a member cannot rewind the version');
update app.notification_templates set locale = 'fr' where id = tests.id('t_sms');
select is((select version from app.notification_templates where id = tests.id('t_sms')), 3, 'changing the locale is a new version');
update app.notification_templates set locale = 'en' where id = tests.id('t_sms');
select throws_ok($$ update app.notification_templates set id = gen_random_uuid() where id = tests.id('t_sms') $$,
  '42501', null, 'the id is immutable');
select is((select updated_by from app.notification_templates where id = tests.id('t_sms')), tests.id('manager'),
  'the editor is recorded');
select results_eq($$ select version, body from app.notification_template_versions
                     where template_id = tests.id('t_sms') order by version $$,
  $$ values (1, 'Go to {{counter}}, {{guest_first_name}}.'), (2, 'Now serving {{ticket}}'),
            (3, 'Now serving {{ticket}}'), (4, 'Now serving {{ticket}}') $$,
  'a snapshot exists per version');
select is((select count(*)::int from app.notification_template_versions where template_id = tests.id('t_sms')), 4,
  'managers read snapshots');
select tests.as_postgres();
select throws_ok($$ update app.notification_template_versions set body = 'x' where template_id = tests.id('t_sms') $$,
  '42501', null, 'AC2: snapshots cannot be updated, even by the table owner');
select throws_ok($$ delete from app.notification_template_versions where template_id = tests.id('t_sms') $$,
  '42501', null, '... or deleted');

------------------------------------------------------------------------------------------------
-- Who may write (AC3)
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, body)
  values (tests.id('org_a'), 'called', 'push', 'x') $$, '42501', null, 'staff cannot write templates');
select tests.act_as('other_owner');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, body)
  values (tests.id('org_a'), 'called', 'push', 'x') $$, '42501', null, 'AC3: org B cannot add to org A');
select is(tests.changed($q$update app.notification_templates set body = 'hijack'
  where id = tests.id('t_sms')$q$), 0, 'AC3: org B cannot edit an org A template');
select is(tests.changed($q$update app.notification_templates set body = 'hijack'
  where org_id is null$q$), 0, 'system defaults are read-only to every org');
select is(tests.changed($q$delete from app.notification_templates where org_id is null$q$), 0,
  '... and cannot be deleted');
select is((select count(*)::int from app.notification_template_versions), 0, 'org B reads no org A snapshots');
select tests.as_postgres();

------------------------------------------------------------------------------------------------
-- Resolution order
------------------------------------------------------------------------------------------------
-- org A default locale en. Locales: guest fr.
update app.organizations set default_locale = 'en' where id = tests.id('org_a');
-- The system defaults for removed (2A-NT1) would shadow the fixtures this resolution test sets up.
delete from app.notification_templates where org_id is null and trigger = 'removed';
insert into app.notification_templates (id, org_id, trigger, channel, locale, body) values
  (tests.id('sys_fr'), null, 'removed', 'push', 'fr', 'sys fr'),
  (tests.id('sys_en'), null, 'removed', 'push', 'en', 'sys en');
create function tests.resolved(p_locale text, p_queue text default 'queue_a') returns text
language sql as $$
  select body from private.resolve_template(tests.id('org_a'), tests.id(p_queue), 'removed', 'push', p_locale)
$$;
select is(tests.resolved('fr'), 'sys fr', 'system default in the guest''s locale');
select is(tests.resolved('de'), 'sys en', 'falls back to English');
insert into app.notification_templates (id, org_id, trigger, channel, locale, body)
values (tests.id('org_en'), tests.id('org_a'), 'removed', 'push', 'en', 'org en');
select is(tests.resolved('fr'), 'org en', 'an org override in the org default locale beats the system default');
insert into app.notification_templates (id, org_id, trigger, channel, locale, body)
values (tests.id('org_fr'), tests.id('org_a'), 'removed', 'push', 'fr', 'org fr');
select is(tests.resolved('fr'), 'org fr', 'org + guest locale beats org + default locale');
insert into app.notification_templates (id, org_id, queue_id, trigger, channel, locale, body)
values (tests.id('q_fr'), tests.id('org_a'), tests.id('queue_a'), 'removed', 'push', 'fr', 'queue fr');
select is(tests.resolved('fr'), 'queue fr', 'queue + guest locale wins');
update app.notification_templates set active = false where id = tests.id('q_fr');
select is(tests.resolved('fr'), 'org fr', 'an inactive override is skipped');

select * from finish();
rollback;
