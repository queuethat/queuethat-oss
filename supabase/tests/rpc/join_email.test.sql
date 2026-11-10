-- #479 re-review: join takes a plain ASCII email only, so look-alikes and exotic syntax can't slip
-- past canonical_email and the block list.
begin;
\ir ../helpers/_setup.psql
select plan(13);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_mail'), tests.id('org_a'), tests.id('loc_a'), 'Mail', 'M');
grant select on tests.ids to anon;

create table tests.bad_emails (label text, email text);
insert into tests.bad_emails values
  ('a full-width letter', 'victim@ｇmail.com'),
  ('a Cyrillic letter', 'viсtim@gmail.com'),
  ('an accented letter', 'josé@example.com'),
  ('a quoted local part', '"victim"@example.com'),
  ('a comment', 'victim(comment)@example.com'),
  ('an IP-literal domain', 'victim@[1.2.3.4]'),
  ('a bare IP domain', 'victim@127.0.0.1'),
  ('a trailing dot on the domain', 'victim@example.com.'),
  ('a space inside', 'vic tim@example.com'),
  ('255 characters', repeat('a', 243) || '@example.com');
grant select on tests.bad_emails to anon;

select tests.as_anon();
select throws_ok(format($$ select api.join_queue(tests.id('queue_mail'), null, 'Lee', null, %L, 1, null, gen_random_uuid()) $$, email),
                 'P0001', 'invalid_input', 'an email with ' || label || ' is rejected')
from tests.bad_emails order by label;

select lives_ok($$ select api.join_queue(tests.id('queue_mail'), null, 'Lee', null, ' Lee.O''Brien+q@Mail.Example.co.uk ', 1, null, gen_random_uuid()) $$,
  'a +tag, apostrophe, subdomain and upper case are accepted');
select lives_ok($$ select api.join_queue(tests.id('queue_mail'), null, 'Lee', null, repeat('a', 242) || '@example.com', 1, null, gen_random_uuid()) $$,
  'a 254-character email is accepted');
select tests.as_postgres();

select is((select guest_email from app.visits where guest_email like 'lee.%'), 'lee.o''brien+q@mail.example.co.uk',
  'the accepted email is stored trimmed and lower-cased, as typed otherwise');

select * from finish();
rollback;
