-- 2B-C1 (#300): guest tags and notes.
begin;
\ir ../helpers/_setup.psql
select plan(13);
select tests.create_world();

-- AC1: staff tag a guest; a duplicate link and a case-variant tag name are rejected.
select tests.act_as('manager');
select lives_ok($$ insert into app.guest_tags (org_id, name) values (tests.id('org_a'), 'VIP') $$, 'manager creates a tag');
select throws_ok($$ insert into app.guest_tags (org_id, name) values (tests.id('org_a'), 'vip') $$, '23505', null,
  'AC1: tag names are unique per org, case-insensitively');
select tests.act_as('staff');
select throws_ok($$ insert into app.guest_tags (org_id, name) values (tests.id('org_a'), 'Staff made') $$, '42501', null,
  'staff cannot define new tags');
select lives_ok($$ insert into app.guest_tag_links (org_id, guest_id, tag_id)
  values (tests.id('org_a'), tests.id('guest_a'), tests.id('gtag_b')) $$, 'AC1: staff tag a guest');
select throws_ok($$ insert into app.guest_tag_links (org_id, guest_id, tag_id)
  values (tests.id('org_a'), tests.id('guest_a'), tests.id('gtag_b')) $$, '23505', null, 'AC1: a duplicate link is rejected');

-- Notes: the author soft-deletes; the body cannot be edited; others cannot delete.
select lives_ok($$ insert into app.guest_notes (org_id, guest_id, author_user_id, body)
  values (tests.id('org_a'), tests.id('guest_a'), (select auth.uid()), 'Allergic to latex') $$, 'staff add a note as themselves');
select throws_ok($$ insert into app.guest_notes (org_id, guest_id, author_user_id, body)
  values (tests.id('org_a'), tests.id('guest_a'), tests.id('owner'), 'forged') $$, '42501', null, 'a note cannot name another author');
select throws_ok($$ update app.guest_notes set body = 'edited' where id = tests.id('gnote_a') $$, '42501', null,
  'note text is not editable');
select tests.act_as('manager');
update app.guest_notes set deleted_at = now() where id = tests.id('gnote_a');
select tests.as_postgres();
select is((select deleted_at from app.guest_notes where id = tests.id('gnote_a')), null,
  'a manager who is not the author cannot delete the note');
select tests.act_as('staff');
update app.guest_notes set deleted_at = now() where id = tests.id('gnote_a');
select tests.as_postgres();
select isnt((select deleted_at from app.guest_notes where id = tests.id('gnote_a')), null,
  'the author soft-deletes their note');

-- AC2: erasing the guest removes tag links and notes.
select tests.as_postgres();
delete from app.guests where id = tests.id('guest_a');
select is((select count(*) from app.guest_tag_links where guest_id = tests.id('guest_a')) +
          (select count(*) from app.guest_notes where guest_id = tests.id('guest_a')), 0::bigint,
  'AC2: tag links and notes are removed with the guest');

-- AC3: org B sees nothing and cannot insert into org A.
select tests.act_as('other_owner');
select is((select count(*) from app.guest_tags where org_id = tests.id('org_a')), 0::bigint, 'AC3: org B reads no org A tags');
select throws_ok($$ insert into app.guest_tags (org_id, name) values (tests.id('org_a'), 'Evil') $$, '42501', null,
  'AC3: org B cannot insert into org A');

select * from finish();
rollback;
