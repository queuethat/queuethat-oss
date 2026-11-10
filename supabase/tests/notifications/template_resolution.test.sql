-- 2B-Q12 (#237): queue > org > system template resolution, locale fallback, tenant isolation, and
-- the queue branding overrides.
begin;
\ir ../helpers/_setup.psql
select plan(11);
select tests.create_world();

insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_x'), tests.id('org_a'), tests.id('loc_a'), 'Repairs', 'R'),
  (tests.new_id('queue_y'), tests.id('org_a'), tests.id('loc_a'), 'Pickups', 'P');
insert into app.notification_templates (org_id, queue_id, trigger, channel, locale, body) values
  (tests.id('org_a'), tests.id('queue_x'), 'called', 'sms', 'en', 'queue text'),
  (tests.id('org_a'), null, 'called', 'sms', 'en', 'org text'),
  (tests.id('org_a'), null, 'called', 'sms', 'es', 'texto de la org');

select is((select body from private.resolve_template(tests.id('org_a'), tests.id('queue_x'), 'called', 'sms', 'en')),
  'queue text', 'AC1: the queue template wins for its own queue');
select is((select body from private.resolve_template(tests.id('org_a'), tests.id('queue_y'), 'called', 'sms', 'en')),
  'org text', 'AC1: another queue uses the org template');

update app.organizations set default_locale = 'es' where id = tests.id('org_a');
select is((select body from private.resolve_template(tests.id('org_a'), tests.id('queue_y'), 'called', 'sms', 'fr')),
  'texto de la org', 'AC2: no template in fr falls back to the org default locale');
update app.organizations set default_locale = 'de' where id = tests.id('org_a');
select ok((select body from private.resolve_template(tests.id('org_a'), tests.id('queue_y'), 'called', 'sms', 'fr')) is not null,
  'AC2: and then to English (or the system default)');
select is((select locale from private.resolve_template(tests.id('org_a'), tests.id('queue_y'), 'called', 'sms', 'fr')),
  'en', 'AC2: the fallback locale is en');

select throws_ok($$insert into app.notification_templates (org_id, queue_id, trigger, channel, locale, body)
  values (tests.id('org_a'), tests.id('queue_x'), 'called', 'sms', 'en', 'dup')$$,
  '23505', null, 'one template per queue, trigger, channel and locale');

select tests.act_as('other_owner');
select is((select count(*) from app.notification_templates where queue_id = tests.id('queue_x'))::int, 0,
  'AC3: staff of org B see no org A queue templates');
select tests.as_postgres();

-- Branding overrides
select throws_ok($$update app.queues set brand_accent = 'red' where id = tests.id('queue_x')$$,
  '23514', null, 'the accent must be #rrggbb');
select throws_ok(format($$update app.queues set welcome_text = %L where id = tests.id('queue_x')$$, repeat('x', 281)),
  '23514', null, 'welcome text is at most 280 characters');
update app.organizations set brand_accent = '#112233' where id = tests.id('org_a');
update app.locations set welcome_text = 'location welcome' where id = tests.id('loc_a');
update app.queues set brand_accent = '#aabbcc', welcome_text = 'queue welcome' where id = tests.id('queue_x');
select results_eq($$select * from private.effective_queue_branding(tests.id('queue_x'))$$,
  $$values ('#aabbcc'::text, 'queue welcome'::text)$$, 'a queue override wins');
select results_eq($$select * from private.effective_queue_branding(tests.id('queue_y'))$$,
  $$values ('#112233'::text, 'location welcome'::text)$$, 'without one, the org accent and location welcome apply');

select * from finish();
rollback;
