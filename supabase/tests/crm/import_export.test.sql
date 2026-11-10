-- 2B-C5 (#304): guest import and export.
begin;
\ir ../helpers/_setup.psql
select plan(19);
select tests.create_world();

-- Import
select tests.act_as('admin');
create temp table res as
  select * from api.import_guests(tests.id('org_a'), $j$[
    {"name": "Gina again", "phone": "(415) 555-0123", "country": "US"},
    {"name": "Newbie", "email": "New@Example.com", "tags": ["Imported", "VIP"]},
    {"name": "Consenting", "phone": "+442071838750", "transactional_consent": "yes", "consent_text_version": "v7"},
    {"name": "Nobody"},
    {"name": "Bad phone", "phone": "12345"}
  ]$j$::jsonb, '00000000-0000-0000-0000-0000000000d1');
grant select on res to public;
select is((select outcome from res where row_no = 1), 'matched', 'AC1: an existing phone is matched');
select is((select guest_id from res where row_no = 1), tests.id('guest_a'), 'AC1: it is the existing guest');
select tests.as_postgres();
select is((select count(*) from app.guest_contacts where org_id = tests.id('org_a') and value = '+14155550123'), 1::bigint,
  'AC1: no duplicate contact');
select is((select outcome from res where row_no = 2), 'created', 'a new email creates a guest');
select is((select count(*) from app.consents k join app.guest_contacts c on c.id = k.contact_id
           where c.guest_id = (select guest_id from res where row_no = 2)), 0::bigint, 'AC2: no consent without a consent column');
select is((select count(*) from app.guest_tag_links where guest_id = (select guest_id from res where row_no = 2)), 2::bigint, 'tags are created and linked');
select is((select status || ':' || source || ':' || consent_text_version from app.consents k join app.guest_contacts c on c.id = k.contact_id
           where c.guest_id = (select guest_id from res where row_no = 3)), 'granted:import:v7', 'a stated transactional consent is recorded as import');
select is((select count(*) from app.consents where purpose = 'marketing' and source = 'import'), 0::bigint, 'never a marketing consent');
select is((select string_agg(outcome, ',' order by row_no) from res where row_no > 3), 'invalid,invalid', 'rows without a usable contact are invalid');
select tests.act_as('admin');
select is((select count(*) from api.import_guests(tests.id('org_a'), $j$[{"name": "Gina again", "phone": "(415) 555-0123", "country": "US"}]$j$::jsonb,
  '00000000-0000-0000-0000-0000000000d1')), 5::bigint, 'replaying a key returns the first result');
select throws_ok($$ select * from api.import_guests(tests.id('org_a'),
  (select jsonb_agg(jsonb_build_object('email', 'x' || g || '@example.com')) from generate_series(1, 1001) g), gen_random_uuid()) $$,
  'P0001', 'invalid_input', 'more than 1000 rows is rejected');
-- A revoked consent is never re-granted by an import; a key is bound to its org.
select tests.as_postgres();
update app.consents set status = 'revoked', revoked_at = now() where id = tests.id('consent_a');
delete from app.consents where contact_id = tests.id('contact_a') and id <> tests.id('consent_a');
select tests.act_as('admin');
select count(*) from api.import_guests(tests.id('org_a'), '[{"phone": "+14155550123", "transactional_consent": "true", "consent_text_version": "v9"}]', gen_random_uuid());
select tests.as_postgres();
select is((select count(*) from app.consents where contact_id = tests.id('contact_a')), 1::bigint, 'an import does not re-grant a revoked consent');
select tests.act_as('admin');
select throws_ok($$ select * from api.import_guests(tests.id('org_b'), '[]', '00000000-0000-0000-0000-0000000000d1') $$, 'P0001', 'not_found', 'a key replayed against another org is refused');
select tests.act_as('manager');
select throws_ok($$ select * from api.import_guests(tests.id('org_a'), '[]', gen_random_uuid()) $$, 'P0001', 'not_found', 'a manager cannot import');

-- Export
select tests.act_as('admin');
select ok((select count(*) from api.export_guests(tests.id('org_a'))) >= 3, 'an admin exports the guests');
select tests.act_as('manager');
select throws_ok($$ select * from api.export_guests(tests.id('org_a')) $$, 'P0001', 'not_found', 'a manager cannot export');
select tests.act_as('other_owner');
select throws_ok($$ select * from api.export_guests(tests.id('org_a')) $$, 'P0001', 'not_found', 'AC5: another org cannot export');
select tests.act_as('admin');
do $$ begin perform count(*) from api.export_guests(tests.id('org_a')); perform count(*) from api.export_guests(tests.id('org_a')); perform count(*) from api.export_guests(tests.id('org_a')); end $$;
select lives_ok($$ select count(*) from api.export_guests(tests.id('org_a')) $$, 'fifth export of the day');
select throws_ok($$ select count(*) from api.export_guests(tests.id('org_a')) $$, 'P0001', 'rate_limited', 'AC3: the sixth export is rate limited');

select * from finish();
rollback;
