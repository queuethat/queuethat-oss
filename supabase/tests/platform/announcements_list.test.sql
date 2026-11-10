-- PLT13 (#419): operators list live and scheduled announcements; everyone else still reads only
-- the active ones through the table.
begin;
\ir ../helpers/_setup.psql
select plan(8);
select tests.create_world();

insert into app.platform_announcements (severity, message, starts_at, ends_at) values
  ('info', 'ended yesterday', now() - interval '2 days', now() - interval '1 day'),
  ('warning', 'starts tomorrow', now() + interval '1 day', now() + interval '2 days');
create function tests.as_aal1_operator() returns void
language sql as $$ select tests.as_user(tests.id('platform'), '{"aal":"aal1"}') $$;
grant execute on function tests.as_aal1_operator() to authenticated;

select tests.act_as('platform');
select results_eq(
  $$ select message from api.platform_list_announcements() $$,
  $$ values ('fixture announcement'), ('starts tomorrow') $$,
  'an operator sees the live and the scheduled announcement, earliest first, not the ended one');

select tests.act_as('staff');
select results_eq($$ select message from app.platform_announcements $$, $$ values ('fixture announcement') $$,
  'staff still read only the active announcement');
select throws_ok($$ select * from api.platform_list_announcements() $$, '42501', null,
  'staff cannot list scheduled announcements');
select tests.act_as('display');
select results_eq($$ select message from app.platform_announcements $$, $$ values ('fixture announcement') $$,
  'paired devices still read only the active announcement');
select tests.act_as('other_owner');
select throws_ok($$ select * from api.platform_list_announcements() $$, '42501', null,
  'an owner of another org cannot list them');

select tests.as_aal1_operator();
select throws_ok($$ select * from api.platform_list_announcements() $$, '42501', null,
  'an operator without MFA cannot list them');

reset role;
insert into app.platform_roles (user_id, role) values (tests.id('staff'), 'support');
select tests.as_user(tests.id('staff'), '{"aal":"aal2"}');
select throws_ok($$ select * from api.platform_list_announcements() $$, '42501', null,
  'a support role with MFA cannot list them, only an operator can');

select tests.act_as('anon');
select throws_ok($$ select * from api.platform_list_announcements() $$, '42501', null,
  'anon cannot list them');

select * from finish();
rollback;
