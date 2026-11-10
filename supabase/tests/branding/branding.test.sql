-- 2P-BRD1 (#202): branding columns, their checks and api.get_location_branding.
begin;
\ir ../helpers/_setup.psql
select plan(14);
select tests.create_world();

select tests.act_as('admin');
select lives_ok(format($$
  update app.organizations set brand_primary = '#112233', brand_accent = '#AABBCC', logo_path = 'org/%1$s/branding/logo.webp' where id = %2$L
$$, tests.id('org_a'), tests.id('org_a')), 'an admin sets logo and colours');
select lives_ok(format($$
  update app.locations set cover_path = 'org/%1$s/branding/cover.webp', welcome_text = 'Welcome <b>in</b>',
    terms_url = 'https://example.com/terms', privacy_url = 'https://example.com/privacy' where id = %2$L
$$, tests.id('org_a'), tests.id('loc_a')), 'an admin sets cover, welcome text and links');
select throws_ok(format($$ update app.locations set terms_url = 'javascript:alert(1)' where id = %L $$, tests.id('loc_a')),
  '23514', null, 'AC4: a javascript: URL is rejected');
select throws_ok(format($$ update app.locations set privacy_url = 'http://example.com/p' where id = %L $$, tests.id('loc_a')),
  '23514', null, 'AC4: an http:// URL is rejected');
select throws_ok(format($$ update app.organizations set brand_primary = 'red' where id = %L $$, tests.id('org_a')),
  '23514', null, 'a colour must be #rrggbb');
select throws_ok(format($$ update app.organizations set logo_path = 'org/%s/branding/logo.png' where id = %L $$,
  tests.id('org_b'), tests.id('org_a')), '23514', null, 'a logo path under another org is rejected');
select throws_ok(format($$ update app.locations set welcome_text = %L where id = %L $$, repeat('x', 501), tests.id('loc_a')),
  '23514', null, 'welcome text is capped at 500 characters');

select tests.act_as('manager');
update app.organizations set brand_primary = '#000000' where id = tests.id('org_a');
select tests.as_postgres();
select is((select brand_primary from app.organizations where id = tests.id('org_a')), '#112233', 'AC3: a manager cannot change branding');

select tests.as_anon();
select is((select (api.get_location_branding('test-location-a')).org_name), 'Org A', 'AC5: anon reads the org name');
select is((select (api.get_location_branding('test-location-a')).logo_url),
  format('/storage/v1/object/public/branding/org/%s/branding/logo.webp', tests.id('org_a')), 'logo as a public path');
select is((select (api.get_location_branding('test-location-a')).welcome_text), 'Welcome <b>in</b>',
  'welcome text is returned verbatim (clients render it as plain text)');
select is((select count(*)::int from jsonb_object_keys(to_jsonb(api.get_location_branding('test-location-a')))), 9,
  'AC5: exactly the nine public fields are returned (the eight branding ones and the 4-WL1 flag)');
select throws_ok($$ select api.get_location_branding('no-such-place') $$, 'P0001', 'not_found', 'an unknown slug is not_found');
select tests.as_postgres();
insert into app.slug_redirects (org_id, location_id, old_slug) values (tests.id('org_a'), tests.id('loc_a'), 'old-a');
select tests.as_anon();
select is((select (api.get_location_branding('old-a')).org_name), 'Org A', 'a retired slug still resolves');

select * from finish();
rollback;
