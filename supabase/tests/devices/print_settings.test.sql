-- 2B-D3 (#260): paper width and footer for ticket slips.
begin;
\ir ../helpers/_setup.psql
select plan(7);
select tests.create_world();

create function tests.error_of(p_sql text) returns text
language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlstate; end $$;
grant execute on function tests.error_of(text) to authenticated;

select is((select (print_paper_mm, print_footer)::text from app.locations where id = tests.id('loc_a')),
  '(80,)', 'defaults: 80 mm, no footer');
select tests.act_as('admin');
select lives_ok($$ update app.locations set print_paper_mm = 58, print_footer = 'Thanks for waiting'
  where id = tests.id('loc_a') $$, 'an admin sets 58 mm and a footer');
select tests.act_as('kiosk');
select is((select print_paper_mm from app.locations where id = tests.id('loc_a')), 58, 'a kiosk reads the width');
select tests.act_as('admin');
select is(tests.error_of($$ update app.locations set print_paper_mm = 70 where id = tests.id('loc_a') $$),
  '23514', 'only 58 and 80 are allowed');
select is(tests.error_of(format('update app.locations set print_footer = %L where id = %L', repeat('x', 121), tests.id('loc_a'))),
  '23514', 'a footer over 120 characters is rejected');
select tests.act_as('other_owner');
select is((select count(*)::int from app.locations where id = tests.id('loc_a')), 0, 'org B cannot read org A''s settings');
select tests.act_as('kiosk');
select is(tests.error_of($$ update app.locations set print_paper_mm = 80 where id = tests.id('loc_a') $$),
  'ok', 'a kiosk update changes nothing (no policy match)');
select * from finish();
rollback;
