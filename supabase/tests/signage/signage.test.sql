-- 4-SIG1 (#389): slide constraints, api.display_signage and the signage bucket.
begin;
\ir ../helpers/_setup.psql
select plan(19);
select tests.create_world();

create function tests.put(p_path text) returns void language sql as $$
  insert into storage.objects (bucket_id, name) values ('signage', p_path)
$$;
grant execute on function tests.put(text) to authenticated, anon;

select is((select public from storage.buckets where id = 'signage'), true, 'the signage bucket is public');
select is((select file_size_limit from storage.buckets where id = 'signage'), 5242880::bigint, 'files over 5 MB are rejected by Storage');
select is((select allowed_mime_types from storage.buckets where id = 'signage'),
  array['image/png', 'image/jpeg', 'image/webp'], 'AC2: only png, jpeg and webp are allowed (no SVG)');

-- A second location of org A, so "a display of another location" is tested inside one org.
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_a2'), tests.id('org_a'), 'Location A2', 'test-location-a2', 'UTC');

select tests.id('loc_a') as loc_a, tests.id('loc_b') as loc_b, tests.new_id('loc_a2') as loc_a2, tests.id('org_a') as org_a, tests.id('org_b') as org_b \gset

-- Slides: one always on, one expired, one scheduled for later, one image, sorted out of insertion order.
select tests.as_postgres();
delete from app.signage_slides;
insert into app.signage_slides (org_id, location_id, kind, body, sort, duration_s, active_from, active_to) values
  (:'org_a', :'loc_a', 'text', 'second', 20, 8, null, null),
  (:'org_a', :'loc_a', 'text', 'expired', 0, 8, now() - interval '2 days', now() - interval '1 day'),
  (:'org_a', :'loc_a', 'text', 'later', 0, 8, now() + interval '1 day', null),
  (:'org_a', :'loc_a', 'text', 'first', 10, 5, now() - interval '1 hour', now() + interval '1 hour');
insert into app.signage_slides (org_id, location_id, kind, storage_path, sort)
values (:'org_a', :'loc_a', 'image', format('org/%s/signage/promo.webp', :'org_a'), 30);

select tests.id('display') as display_id \gset
select tests.as_device(:'display_id', 'display', :'org_a', :'loc_a');
select results_eq(format($$ select kind, coalesce(body, image_url), duration_s from api.display_signage(%L) $$, :'loc_a'),
  format($$ values ('text', 'first', 5), ('text', 'second', 8), ('image', '/storage/v1/object/public/signage/org/%s/signage/promo.webp', 10) $$, :'org_a'),
  'a display gets the active slides in sort order, not the expired or scheduled ones');
select throws_ok(format($$ select * from api.display_signage(%L) $$, :'loc_b'), 'P0001', 'not_found',
  'AC1: a display cannot read another organization''s location');
select throws_ok(format($$ select * from api.display_signage(%L) $$, :'loc_a2'), 'P0001', 'not_found',
  'AC1: nor another location of its own organization');

select tests.act_as('staff');
select is((select count(*)::int from api.display_signage(:'loc_a'::uuid)), 3, 'staff of the location can preview');
select tests.act_as('other_owner');
select throws_ok(format($$ select * from api.display_signage(%L) $$, :'loc_a'), 'P0001', 'not_found',
  'AC1: an owner of org B cannot read org A''s slides');
select tests.as_anon();
select throws_ok(format($$ select * from api.display_signage(%L) $$, :'loc_a'), '42501', null, 'anon cannot call it');

-- Constraints.
select tests.act_as('admin');
select lives_ok(format($$ insert into app.signage_slides (org_id, location_id, kind, body) values (%L, %L, 'text', 'Sale') $$,
  :'org_a', :'loc_a'), 'an admin adds a text slide');
select throws_ok(format($$ insert into app.signage_slides (org_id, location_id, kind, body, duration_s) values (%L, %L, 'text', 'x', 1) $$,
  :'org_a', :'loc_a'), '23514', null, 'a slide stays at least 3 seconds');
select throws_ok(format($$ insert into app.signage_slides (org_id, location_id, kind, storage_path) values (%L, %L, 'image', 'org/%s/signage/x.webp') $$,
  :'org_a', :'loc_a', :'org_b'), '23514', null, 'an image path under another org is rejected');
select throws_ok(format($$ insert into app.signage_slides (org_id, location_id, kind, body, active_from, active_to) values (%L, %L, 'text', 'x', now(), now() - interval '1 hour') $$,
  :'org_a', :'loc_a'), '23514', null, 'the window must end after it starts');
select throws_ok(format($$ insert into app.signage_slides (org_id, location_id, kind, body) values (%L, %L, 'text', 'x') $$,
  :'org_b', :'loc_b'), '42501', null, 'an admin cannot add a slide to org B');

-- Bucket.
select lives_ok(format($$ select tests.put('org/%s/signage/a.webp') $$, :'org_a'), 'an admin uploads under their own prefix');
select throws_ok(format($$ select tests.put('org/%s/signage/a.webp') $$, :'org_b'), '42501', null, 'and is denied under org B''s prefix');
select throws_ok(format($$ select tests.put('org/%s/branding/a.webp') $$, :'org_a'), '42501', null,
  'the branding folder is not the signage folder');
select throws_ok(format($$ select tests.put('org/%s/signage/../x.png') $$, :'org_a'), '42501', null, 'path traversal is denied');
select tests.act_as('staff');
select throws_ok(format($$ select tests.put('org/%s/signage/s.webp') $$, :'org_a'), '42501', null, 'staff cannot upload');

select * from finish();
rollback;
