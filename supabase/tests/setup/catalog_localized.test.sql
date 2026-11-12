-- Catalog reads of T2 content (#1296, tracker #1267): {"en", "es"} strings are listed and copied in
-- English; the v1 plain strings still work.
begin;
\ir ../helpers/_setup.psql
select plan(6);

select tests.create_world();
select tests.as_postgres();
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_new'), tests.id('org_a'), 'New place', 'new-place-a', 'America/New_York');
insert into app.template_catalog (key, version, payload, tier, mode) values ('test_salon', 1, $j${
  "key": "test_salon", "version": 1,
  "name": {"en": "Salon", "es": "Salón"}, "description": {"en": "Cuts and colour", "es": "Cortes y color"},
  "queues": [{"name": {"en": "Walk-ins", "es": "Sin cita"}, "prefix": "S", "show_eta": true,
              "services": [{"name": {"en": "Cut", "es": "Corte"}, "minutes": 40}]}],
  "resources": [{"label": {"en": "Chair 1", "es": "Silla 1"}, "kind": "chair"}]
}$j$::jsonb, 1, 'both');

select is(private.catalog_text('{"en": "Cut", "es": "Corte"}', 'es'), 'Corte', 'catalog_text picks the language');
select is(private.catalog_text('{"en": "Cut"}', 'es'), 'Cut', 'and falls back to English');

select tests.act_as('admin');
select is((select name || ' / ' || description from api.list_template_catalog() where key = 'test_salon'),
  'Salon / Cuts and colour', 'the listing names a localized template in English');
select is((select name from api.list_template_catalog() where key = 'clinic'), 'Clinic',
  'v1 plain names still list');
select is((api.apply_industry_template(tests.id('loc_new'), 'test_salon', gen_random_uuid())),
  row('test_salon', 1, 1, 1)::api.template_result, 'apply copies a localized template');
select is((select q.name || ' ' || q.ticket_prefix || ' / ' || s.name || ' ' || s.expected_minutes || ' / ' || c.label
           from app.queues q join app.services s on s.queue_id = q.id join app.counters c on c.location_id = q.location_id
           where q.location_id = tests.id('loc_new')),
  'Walk-ins S / Cut 40 / Chair 1', 'with English names');

select * from finish();
rollback;
