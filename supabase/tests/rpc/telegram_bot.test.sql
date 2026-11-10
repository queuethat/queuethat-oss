-- 4-BOT2 follow-up (#382): the poster reads the bot username, and only that.
begin;
\ir ../helpers/_setup.psql
select plan(5);
delete from vault.secrets where name = 'telegram_bot_username';
select tests.create_world();

select tests.act_as('staff');
select is(api.get_telegram_bot(), null, 'no bot configured: null');
select tests.as_postgres();
select vault.create_secret('QueueThatBot', 'telegram_bot_username');
select tests.act_as('staff');
select is(api.get_telegram_bot(), 'QueueThatBot', 'a signed-in user reads the username');
select tests.as_postgres();
select tests.as_postgres();
delete from vault.secrets where name = 'telegram_bot_username';
select vault.create_secret('not a username!', 'telegram_bot_username');
select tests.act_as('staff');
select is(api.get_telegram_bot(), null, 'a stored value that is not a username is never returned');
select tests.as_anon();
select throws_ok($$ select api.get_telegram_bot() $$, '42501', null, 'anon cannot read it');
select tests.as_postgres();
select is((select pg_get_function_result('api.get_telegram_bot()'::regprocedure)), 'text', 'and the result is only text');

select * from finish();
rollback;
