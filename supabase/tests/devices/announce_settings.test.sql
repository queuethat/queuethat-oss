-- 2B-D6 (#263): per-location announcement settings.
begin;
\ir ../helpers/_setup.psql
select plan(13);
select tests.create_world();

create function tests.error_of(p_sql text) returns text
language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlstate; end $$;
grant execute on function tests.error_of(text) to authenticated;

create function tests.rows_changed(p_sql text) returns int
language plpgsql as $$
declare n int;
begin execute p_sql; get diagnostics n = row_count; return n; end $$;
grant execute on function tests.rows_changed(text) to authenticated;

select is((select (announce_locales, announce_voice_prefs, announce_repeat)::text from app.locations where id = tests.id('loc_a')),
  '({en},{},1)', 'defaults: English only, no voice preferences, spoken once');

select tests.act_as('admin');
select lives_ok($$ update app.locations set announce_locales = '{en,fr}',
  announce_voice_prefs = '{"fr": {"voice": "Amelie", "rate": 0.9}}', announce_repeat = 2
  where id = tests.id('loc_a') $$, 'an admin saves two locales, a voice and a repeat');

-- AC1: a display reads both locales from its location row.
select tests.act_as('display');
select is((select announce_locales::text from app.locations where id = tests.id('loc_a')), '{en,fr}',
  'a display reads both locales');

select tests.act_as('admin');
select is(tests.error_of($$ update app.locations set announce_locales = '{en,xx}' where id = tests.id('loc_a') $$),
  '23514', 'an unsupported locale is a check violation');
select is(tests.error_of($$ update app.locations set announce_locales = '{}' where id = tests.id('loc_a') $$),
  '23514', 'an empty list is rejected');
select is(tests.error_of($$ update app.locations set announce_locales = '{en,en}' where id = tests.id('loc_a') $$),
  '23514', 'duplicates are rejected');
select is(tests.error_of($$ update app.locations set announce_locales = '{en,es,fr,de,pt}' where id = tests.id('loc_a') $$),
  '23514', 'more than four locales are rejected');
select is(tests.error_of($$ update app.locations set announce_repeat = 4 where id = tests.id('loc_a') $$),
  '23514', 'a repeat over 3 is rejected');
select is(tests.error_of($$ update app.locations set announce_voice_prefs = '{"xx": {"voice": "a"}}' where id = tests.id('loc_a') $$),
  '23514', 'voice preferences for an unsupported locale are rejected');
select is(tests.error_of($$ update app.locations set announce_voice_prefs = '{"en": {"rate": 5}}' where id = tests.id('loc_a') $$),
  '23514', 'a rate outside 0.5-2 is rejected');
select is(tests.error_of($$ update app.locations set announce_voice_prefs = '{"en": {"pitch": 1}}' where id = tests.id('loc_a') $$),
  '23514', 'unknown preference keys are rejected');

-- AC3: another org's staff cannot change it; neither can this org's display.
select tests.act_as('other_owner');
select is(tests.rows_changed($$ update app.locations set announce_repeat = 3 where id = tests.id('loc_a') $$), 0,
  'an owner of org B updates nothing in org A');
select tests.act_as('display');
select is(tests.rows_changed($$ update app.locations set announce_repeat = 3 where id = tests.id('loc_a') $$), 0,
  'a display cannot change the settings');

select * from finish();
rollback;
