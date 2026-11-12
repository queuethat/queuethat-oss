-- T4 (#1298): provider-count setup. N personal lines named by the owner plus an optional pool, the
-- template's services and form attached to all in one action; idempotent re-apply; cross-tenant.
begin;
\ir ../helpers/_setup.psql
select plan(24);

select tests.create_world();
select tests.as_postgres();
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_new'), tests.id('org_a'), 'New place', 'new-place-a', 'America/New_York'),
       (tests.new_id('loc_new2'), tests.id('org_a'), 'Second place', 'second-place-a', 'America/New_York');
-- A T2-shaped template: {en, es} strings, two queues sharing a service name, a form, a provider block.
insert into app.template_catalog (key, version, payload, tier, mode, health_tagged) values ('test_practice', 1, $j${
  "key": "test_practice", "version": 1,
  "name": {"en": "Practice", "es": "Consulta"}, "description": {"en": "Doctors", "es": "Médicos"},
  "booking": {"slot_minutes": 15, "buffer_after_minutes": 5, "min_notice_minutes": 0, "max_days_ahead": 60},
  "providers": {"noun": {"en": "doctor", "es": "médico"}, "default_count": 3, "pool": true},
  "queues": [
    {"name": {"en": "Visits", "es": "Visitas"}, "prefix": "V", "show_eta": true,
     "services": [{"name": {"en": "Checkup", "es": "Revisión"}, "minutes": 15},
                  {"name": {"en": "Follow-up", "es": "Seguimiento"}, "minutes": 10, "bookable": false}]},
    {"name": {"en": "Urgent", "es": "Urgente"}, "prefix": "U", "show_eta": true,
     "services": [{"name": {"en": "Checkup", "es": "Revisión"}, "minutes": 20}]}],
  "resources": [{"label": {"en": "Room 1", "es": "Sala 1"}, "kind": "room"}],
  "form": {"name": {"en": "Visit details", "es": "Detalles"}, "fields": [
    {"key": "reason", "type": "short_text", "label": {"en": "Reason", "es": "Motivo"}, "sensitivity": "normal"},
    {"key": "kind", "type": "single_choice", "label": {"en": "Kind", "es": "Tipo"},
     "options": [{"en": "New", "es": "Nuevo"}, {"en": "Returning", "es": "Regular"}]}]}
}$j$::jsonb, 1, 'both', false);

select tests.new_id('key_1');
select tests.act_as('admin');
select is(api.apply_industry_template(tests.id('loc_new'), 'test_practice', tests.id('key_1'),
            array['Dr. Lee', 'Dr. Patel', 'Dr. Ng'], true),
  row('test_practice', 4, 8, 1)::api.template_result, 'AC: 3 personal lines and a pool, 2 services each, 1 room');

-- The lines: named by the owner, provider kind, each pulling from the one pool, distinct prefixes.
select is((select array_agg(q.name || ':' || q.kind order by q.name) from app.queues q where q.location_id = tests.id('loc_new')),
  array['Anyone available:pool', 'Dr. Lee:provider', 'Dr. Ng:provider', 'Dr. Patel:provider'], 'AC: named personal lines plus the pool');
select is((select count(*) from app.queues q join app.queues p on p.id = q.pulls_from and p.kind = 'pool'
           where q.location_id = tests.id('loc_new') and q.kind = 'provider'), 3::bigint, 'every provider pulls from the pool');
select is((select count(distinct q.ticket_prefix) from app.queues q where q.location_id = tests.id('loc_new')), 4::bigint,
  'each line has its own ticket prefix');
select is((select count(*) from app.queues q where q.location_id = tests.id('loc_new')
           and q.origin_template = 'test_practice' and q.origin_version = 1), 4::bigint, 'every line is stamped with its origin');
-- Services: every line offers each distinct template service, first occurrence wins, English text.
select is((select array_agg(distinct s.name || ' ' || s.expected_minutes order by s.name || ' ' || s.expected_minutes)
           from app.services s where s.location_id = tests.id('loc_new')),
  array['Checkup 15', 'Follow-up 10'], 'AC: services copied in English, the first Checkup wins');
select is((select count(*) from app.queues q where q.location_id = tests.id('loc_new')
           and (select count(*) from app.services s where s.queue_id = q.id) = 2), 4::bigint, 'AC: all four lines have both services');
select is((select label from app.counters c where c.location_id = tests.id('loc_new')), 'Room 1', 'localized resource labels are copied');

-- Booking settings: a bookable policy on every bookable service it created.
select is((select count(*) from app.booking_policies b join app.services s on s.id = b.service_id
           where b.location_id = tests.id('loc_new') and b.bookable and s.name = 'Checkup'
             and (b.slot_minutes, b.buffer_after_minutes, b.min_notice_minutes, b.max_days_ahead) = (15, 5, 0, 60)),
  4::bigint, 'each line''s Checkup is bookable with the template''s settings');
select is((select count(*) from app.booking_policies b join app.services s on s.id = b.service_id
           where b.location_id = tests.id('loc_new') and s.name = 'Follow-up'), 0::bigint,
  'a service marked bookable false stays walk-in only');

-- The form: one library copy, published, attached to every line.
select is((select count(*) from app.forms f where f.location_id = tests.id('loc_new') and not f.is_queue_default), 1::bigint,
  'AC: the template form is copied once');
select is((select f.name || ' ' || f.status || ' ' || f.origin_template from app.forms f where f.location_id = tests.id('loc_new')
           and not f.is_queue_default), 'Visit details published test_practice', 'it is published and stamped');
select is((select v.fields -> 1 -> 'options' from app.form_versions v join app.forms f on f.id = v.form_id
           where f.location_id = tests.id('loc_new') and not f.is_queue_default),
  '["New", "Returning"]'::jsonb, 'its localized strings become English text');
select is((select count(distinct t.queue_id) from app.form_targets t join app.forms f on f.id = t.form_id
           where f.location_id = tests.id('loc_new') and not f.is_queue_default), 4::bigint, 'AC: attached to all four lines in one action');

-- Idempotent: the same key replays; a new key re-applies without duplicating anything.
select is(api.apply_industry_template(tests.id('loc_new'), 'test_practice', tests.id('key_1'),
            array['Dr. Lee', 'Dr. Patel', 'Dr. Ng'], true),
  row('test_practice', 4, 8, 1)::api.template_result, 'AC: the same key replays the first result');
select is(api.apply_industry_template(tests.id('loc_new'), 'test_practice', gen_random_uuid(),
            array['Dr. Lee', 'Dr. Patel', 'Dr. Ng'], true),
  row('test_practice', 0, 0, 0)::api.template_result, 'AC: re-applying creates nothing new');
select is((select count(*) from app.forms f where f.location_id = tests.id('loc_new') and not f.is_queue_default), 1::bigint,
  'and still one form');

-- Without the pool, then adding it: existing personal lines get connected.
select api.apply_industry_template(tests.id('loc_new2'), 'test_practice', gen_random_uuid(), array['Dr. Kim'], false);
select is((select pulls_from from app.queues q where q.location_id = tests.id('loc_new2') and q.name = 'Dr. Kim'), null::uuid,
  'no pool: the personal line pulls from nothing');
select api.apply_industry_template(tests.id('loc_new2'), 'test_practice', gen_random_uuid(), array['Dr. Kim'], true);
select is((select p.kind from app.queues q join app.queues p on p.id = q.pulls_from
           where q.location_id = tests.id('loc_new2') and q.name = 'Dr. Kim'), 'pool', 'adding the pool later connects the line');

-- A bad provider list is refused.
select throws_ok($$ select api.apply_industry_template(tests.id('loc_new2'), 'test_practice', gen_random_uuid(),
  array['Dr. Kim', 'dr. kim '], false) $$, 'P0001', 'invalid_input', 'duplicate names are refused');
select throws_ok($$ select api.apply_industry_template(tests.id('loc_new2'), 'test_practice', gen_random_uuid(),
  '{}'::text[], false) $$, 'P0001', 'invalid_input', 'an empty provider list is refused');

-- Three-argument callers keep the old behaviour.
select tests.as_postgres();
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_new3'), tests.id('org_a'), 'Third place', 'third-place-a', 'America/New_York');
select tests.act_as('admin');
select is((api.apply_industry_template(tests.id('loc_new3'), 'barber', gen_random_uuid())).queues_created, 1,
  'the three-argument call still applies the template queues');

-- Cross-tenant and anon.
select tests.act_as('other_owner');
select throws_ok($$ select api.apply_industry_template(tests.id('loc_new'), 'test_practice', gen_random_uuid(),
  array['Dr. X'], true) $$, 'P0001', 'not_found', 'org B gets not_found for an org A location');
select tests.as_anon();
select throws_ok($$ select api.apply_industry_template(tests.id('loc_new'), 'test_practice', gen_random_uuid(),
  array['Dr. X'], true) $$, '42501', null, 'anon cannot apply a template');

select * from finish();
rollback;
