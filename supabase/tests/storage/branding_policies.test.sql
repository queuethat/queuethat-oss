-- 2P-BRD1 (#202): the branding bucket and its storage.objects policies.
begin;
\ir ../helpers/_setup.psql
select plan(14);
select tests.create_world();

create function tests.put(p_path text) returns void language sql as $$
  insert into storage.objects (bucket_id, name) values ('branding', p_path)
$$;
grant execute on function tests.put(text) to authenticated, anon;

select is((select public from storage.buckets where id = 'branding'), true, 'the branding bucket is public');
select is((select file_size_limit from storage.buckets where id = 'branding'), 2097152::bigint,
  'AC2: Storage rejects files over 2 MB (bucket limit)');
select is((select allowed_mime_types from storage.buckets where id = 'branding'),
  array['image/png', 'image/jpeg', 'image/webp'], 'AC2: only png, jpeg and webp are allowed (no SVG)');

select tests.act_as('admin');
select lives_ok(format($$ select tests.put('org/%s/branding/logo.png') $$, tests.id('org_a')),
  'an admin of org A uploads under their own prefix');
select throws_ok(format($$ select tests.put('org/%s/branding/logo.png') $$, tests.id('org_b')), '42501', null,
  'AC1: and is denied under org B''s prefix');
select throws_ok(format($$ select tests.put('org/%s/other/logo.png') $$, tests.id('org_a')), '42501', null,
  'a path outside the branding folder is denied');
select throws_ok(format($$ select tests.put('org/%s/branding/../x.png') $$, tests.id('org_a')), '42501', null,
  'path traversal is denied');
select throws_ok(format($$ select tests.put('org/%s/branding/..') $$, tests.id('org_a')), '42501', null,
  'a dot-only file name is denied');
select throws_ok($$ select tests.put('logo.png') $$, '42501', null, 'a path without an org prefix is denied');
select is((select count(*)::int from storage.objects where bucket_id = 'branding'), 1, 'the admin lists only their own org''s object');

select tests.act_as('manager');
select throws_ok(format($$ select tests.put('org/%s/branding/m.png') $$, tests.id('org_a')), '42501', null,
  'AC3: a manager cannot upload');
select is((select count(*)::int from storage.objects where bucket_id = 'branding'), 0, 'and cannot list');

select tests.as_anon();
select throws_ok(format($$ select tests.put('org/%s/branding/a.png') $$, tests.id('org_a')), '42501', null, 'anon cannot upload');
select is((select count(*)::int from storage.objects where bucket_id = 'branding'), 0, 'anon cannot list the bucket');

select * from finish();
rollback;
