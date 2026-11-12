-- T5-T8 (#1299-#1302): the shipped catalog content is usable as-is. The file lint (scripts/check-templates.ts)
-- checks shape and copy rules; this checks the database's own rules on the newest version of every template.
begin;
\ir ../helpers/_setup.psql
select plan(18);

-- The template's form in one language, as the forms engine stores it.
create function pg_temp.localized_fields(p_fields jsonb, p_lang text) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(
    (f - 'label' - 'help' - 'body' - 'options')
    || jsonb_build_object('label', f -> 'label' ->> p_lang)
    || case when f ? 'help' then jsonb_build_object('help', f -> 'help' ->> p_lang) else '{}' end
    || case when f ? 'body' then jsonb_build_object('body', f -> 'body' ->> p_lang) else '{}' end
    || case when f ? 'options'
            then jsonb_build_object('options', (select jsonb_agg(o ->> p_lang) from jsonb_array_elements(f -> 'options') o))
            else '{}' end
    order by n), '[]')
  from jsonb_array_elements(p_fields) with ordinality x(f, n)
$$;

-- Every (key, language) whose form the forms engine refuses, with its reason.
create function pg_temp.refused_forms() returns text[]
language plpgsql as $$
declare
  c record;
  lang text;
  bad text[] := '{}';
begin
  for c in select distinct on (key) key, payload from app.template_catalog where payload ? 'form' order by key, version desc loop
    foreach lang in array array['en', 'es'] loop
      begin
        perform private.validate_form_fields(pg_temp.localized_fields(c.payload -> 'form' -> 'fields', lang));
      exception when others then
        bad := bad || (c.key || '/' || lang || ': ' || sqlerrm || ' ' || coalesce(nullif(sqlstate, ''), ''));
      end;
    end loop;
  end loop;
  return bad;
end $$;

select ok((select count(*) from app.template_catalog where payload ? 'form') >= 4, 'catalog templates carry forms');
select is(pg_temp.refused_forms(), '{}'::text[], 'every template form passes the forms engine in English and Spanish');

-- Booking defaults fit app.booking_policies.
select is(
  (select array_agg(key order by key) from (select distinct on (key) key, payload from app.template_catalog order by key, version desc) c
   where payload ? 'booking' and not (
     (payload -> 'booking' ->> 'slot_minutes')::int >= 5
     and (payload -> 'booking' ->> 'buffer_after_minutes')::int >= 0
     and (payload -> 'booking' ->> 'min_notice_minutes')::int >= 0
     and (payload -> 'booking' ->> 'max_days_ahead')::int between 1 and 365)),
  null, 'booking defaults are within the booking policy limits');

-- Batch 1 (T5) is published, reviewed (tier 1) and offered for walk-in and booking.
select is((select array_agg(key || ' v' || version || ' t' || tier || ' ' || mode order by key)
           from app.template_catalog where key in ('barber', 'hair_salon', 'nail_salon', 'spa') and version = (
             select max(version) from app.template_catalog c where c.key = template_catalog.key)),
  array['barber v2 t1 both', 'hair_salon v1 t1 both', 'nail_salon v1 t1 both', 'spa v1 t1 both'],
  'T5 templates are tier 1, both modes');
select is((select payload -> 'form' -> 'fields' -> 1 ->> 'sensitivity' from app.template_catalog where key = 'spa'),
  'sensitive', 'the spa injury note is marked sensitive');
select is((select payload -> 'form' -> 'fields' -> 1 ->> 'type' from app.template_catalog where key = 'spa'),
  'short_text', 'and is a short note, not free-form history');

-- Batch 2 (T6): health verticals are tagged, the tattoo studio carries the W6 waiver and an 18+ gate.
select is((select array_agg(key order by key) from app.template_catalog
           where key in ('tattoo_piercing', 'pet_groomer', 'veterinary', 'walk_in_clinic') and health_tagged),
  array['veterinary', 'walk_in_clinic'], 'the vet and the walk-in clinic are health-tagged, the others are not');
select is((select array_agg(f ->> 'type' order by n) from app.template_catalog c,
           jsonb_array_elements(c.payload -> 'form' -> 'fields') with ordinality x(f, n) where c.key = 'tattoo_piercing'),
  array['short_text', 'yes_no', 'agreement', 'agreement', 'signature'], 'tattoo: piece, age, consent, aftercare, signature');
select is((select f -> 'must_be_true' from app.template_catalog c, jsonb_array_elements(c.payload -> 'form' -> 'fields') f
           where c.key = 'tattoo_piercing' and f ->> 'type' = 'yes_no'), 'true'::jsonb, 'the age question only accepts yes');
select ok((select payload -> 'waiver_banner' ->> 'en' from app.template_catalog where key = 'tattoo_piercing') ilike '%not legal advice%',
  'the tattoo template shows the not-legal-advice banner');

-- Batch 3 (T7): practices are health-tagged with a personal line per provider plus the optional pool;
-- the pharmacy asks nothing a guest could answer with a medicine name.
select is((select array_agg(key order by key) from app.template_catalog
           where key in ('family_practice', 'dental', 'physio_chiro', 'pharmacy') and health_tagged),
  array['dental', 'family_practice', 'pharmacy', 'physio_chiro'], 'every T7 template is health-tagged');
select is((select array_agg(key order by key) from app.template_catalog
           where key in ('family_practice', 'dental', 'physio_chiro') and (payload -> 'providers' ->> 'pool')::boolean),
  array['dental', 'family_practice', 'physio_chiro'], 'practices default to personal lines plus the optional pool');
select is((select count(*) from app.template_catalog c, jsonb_array_elements(c.payload -> 'form' -> 'fields') f
           where c.key = 'pharmacy' and f ->> 'type' in ('short_text', 'long_text')), 0::bigint,
  'the pharmacy form has no free-text question');

-- Batch 4 (T8): the repair templates ask the make and model (plate optional) and the device and issue;
-- and the reviewed launch catalog is exactly the 14 Tier-1 templates.
select is((select array_agg(f ->> 'key' || ':' || coalesce(f ->> 'required', 'false') order by n)
           from app.template_catalog c, jsonb_array_elements(c.payload -> 'form' -> 'fields') with ordinality x(f, n)
           where c.key = 'auto_repair'), array['vehicle:true', 'plate:false', 'issue:false'], 'auto: make required, plate optional');
select is((select array_agg(key order by key) from (select distinct on (key) key, tier from app.template_catalog
           order by key, version desc) c where tier = 1),
  array['auto_repair', 'barber', 'dental', 'device_repair', 'family_practice', 'hair_salon', 'nail_salon', 'pet_groomer',
        'pharmacy', 'physio_chiro', 'spa', 'tattoo_piercing', 'veterinary', 'walk_in_clinic'],
  'the Tier-1 catalog is the 14 reviewed templates');

-- The barber copy made before v2 is untouched: version 1 is still there for existing copies' provenance.
select is((select count(*) from app.template_catalog where key = 'barber'), 2::bigint, 'barber keeps v1 beside v2');

-- Tenants read but never write the new rows.
select tests.create_world();
select tests.act_as('owner');
select throws_ok($$ update app.template_catalog set tier = 3 where key = 'spa' $$, '42501', null,
  'an owner cannot change a published template');

-- Every newest template applies cleanly to a fresh location (T4's copy of queues, services, lines,
-- booking defaults and form), one location each.
select tests.as_postgres();
create function pg_temp.failed_applies() returns text[]
language plpgsql as $$
declare
  k text;
  loc uuid;
  bad text[] := '{}';
begin
  for k in select distinct key from app.template_catalog order by key loop
    loc := gen_random_uuid();
    insert into app.locations (id, org_id, name, slug, tz)
    values (loc, tests.id('org_a'), 'Try ' || k, 'try-' || replace(k, '_', '-'), 'America/Toronto');
    begin
      perform api.apply_industry_template(loc, k, gen_random_uuid());
    exception when others then
      bad := bad || (k || ': ' || sqlerrm);
    end;
  end loop;
  return bad;
end $$;
grant execute on function pg_temp.failed_applies() to authenticated;
select tests.act_as('owner');
select is(pg_temp.failed_applies(), '{}'::text[], 'every catalog template applies to a fresh location');

select * from finish();
rollback;
