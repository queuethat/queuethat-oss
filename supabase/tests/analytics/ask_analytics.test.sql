-- 4-AI1 (#394): the llm channel, the opt-in and api.ask_analytics_reserve (role, opt-in, daily cap, log).
begin;
\ir ../helpers/_setup.psql
select plan(16);
select tests.create_world();
delete from app.analytics_questions; -- the world's fixture row would count toward today's cap

select tests.as_user(tests.id('owner'));
select throws_ok(format($$ select api.ask_analytics_reserve(%L, 'Why was Tuesday slow?') $$, tests.id('org_a')),
  'P0001', 'analytics_disabled', 'off by default: the owner has not opted in');

select lives_ok(format($$ select api.set_provider_settings(%L, 'llm', 'anthropic', 'own', '{"daily_cap": 2}', '{"api_key": "sk-test-0123456789abcdef"}', gen_random_uuid()) $$, tests.id('org_a')),
  'an owner saves the llm key and daily cap');
select is((select secret_hints ->> 'api_key' from app.provider_settings where channel = 'llm'), 'cdef',
  'only the last four characters are readable');
select throws_ok(format($$ select api.ask_analytics_reserve(%L, 'Why was Tuesday slow?') $$, tests.id('org_a')),
  'P0001', 'analytics_disabled', 'saving the key does not switch the channel on');
select lives_ok(format($$ select api.set_channel_enabled(%L, 'llm', true, gen_random_uuid()) $$, tests.id('org_a')),
  'the owner opts in without the SMS compliance gate or a provider test event');

select tests.as_postgres();
select tests.as_user(tests.id('manager'));
select is(api.ask_analytics_reserve(tests.id('org_a'), '  Why was Tuesday slow?  '), 1, 'a manager asks; one question remains of the cap of 2');
select is(api.ask_analytics_reserve(tests.id('org_a'), 'And Wednesday?'), 0, 'the second uses the last slot');
select throws_ok(format($$ select api.ask_analytics_reserve(%L, 'One more?') $$, tests.id('org_a')),
  'P0001', 'rate_limited', 'the cap is enforced');
select throws_ok(format($$ select api.ask_analytics_reserve(%L, '') $$, tests.id('org_a')),
  'P0001', 'invalid_input', 'an empty question is refused');

select tests.as_postgres();
select is((select count(*)::int from app.analytics_questions where question = 'Why was Tuesday slow?'), 1,
  'the log holds the trimmed question text and no answer column exists');

select tests.as_user(tests.id('staff'));
select throws_ok(format($$ select api.ask_analytics_reserve(%L, 'Why?') $$, tests.id('org_a')),
  '42501', null, 'staff cannot ask');
select tests.as_postgres();
select tests.as_user(tests.id('other_owner'));
select throws_ok(format($$ select api.ask_analytics_reserve(%L, 'Why?') $$, tests.id('org_a')),
  'P0001', 'not_found', 'another org gets not_found');

select tests.as_postgres();
select tests.as_service();
select is((api.get_channel_config(tests.id('org_a'), 'llm')).secrets ->> 'api_key', 'sk-test-0123456789abcdef',
  'the dispatcher side (service role) reads the key back from Vault');
select tests.as_postgres();
select tests.as_user(tests.id('owner'));
select lives_ok(format($$ select api.set_channel_enabled(%L, 'llm', false, gen_random_uuid()) $$, tests.id('org_a')), 'the owner switches it off');
select throws_ok(format($$ select api.ask_analytics_reserve(%L, 'Why?') $$, tests.id('org_a')),
  'P0001', 'analytics_disabled', 'and questions stop at once');
select tests.as_postgres();
update app.provider_settings set config = '{"daily_cap": "abc"}' where channel = 'llm';
update app.provider_settings set enabled = true where channel = 'llm';
select tests.as_user(tests.id('manager'));
select is(api.ask_analytics_reserve(tests.id('org_a'), 'A malformed cap falls back to 50'), 47, 'a non-numeric daily_cap means the default, not an error');
select * from finish();
rollback;
