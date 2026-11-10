-- Turnstile hostname check (join_pass_hostname migration): a pass is issued only for a token
-- solved on one of the deployment's own hostnames, so a token minted on another site that
-- reuses the public site key can't buy a join.
begin;
\ir ../helpers/_setup.psql
select plan(12);

select tests.as_service();
select isnt(api.issue_join_pass('anything.example'), null,
  'with Turnstile off, passes are not needed and the hostname is not checked');
select tests.as_postgres();

update private.deployment_settings set turnstile_site_key = '1x00000000000000000000AA';
select tests.as_service();
select throws_ok($$ select api.issue_join_pass('queue.example.com') $$, 'P0001', 'captcha_required',
  'with Turnstile on and no hostnames listed, no pass is issued (fails closed)');
select tests.as_postgres();

update private.deployment_settings set turnstile_hostnames = '{queue.example.com,join.example.org}';
select tests.as_service();
select isnt(api.issue_join_pass('queue.example.com'), null, 'a listed hostname gets a pass');
select isnt(api.issue_join_pass('JOIN.Example.org'), null, 'hostnames compare case-insensitively');
select throws_ok($$ select api.issue_join_pass('evil.example.net') $$, 'P0001', 'captcha_required',
  'another site''s hostname gets none');
select throws_ok($$ select api.issue_join_pass('queue.example.com.evil.net') $$, 'P0001',
  'captcha_required', 'nor does a lookalike that only starts with a listed one');
select throws_ok($$ select api.issue_join_pass(null) $$, 'P0001', 'captcha_required',
  'nor does a missing hostname');
select tests.as_postgres();

select throws_ok($$ update private.deployment_settings set turnstile_hostnames = '{https://queue.example.com}' $$,
  '23514', null, 'the list takes bare hostnames, not URLs');
select throws_ok($$ update private.deployment_settings set turnstile_hostnames = '{queue.example.com,""}' $$,
  '23514', null, 'nor blanks');
select throws_ok($$ update private.deployment_settings set turnstile_hostnames = '{""}' $$,
  '23514', null, 'nor a lone blank');
select throws_ok($$ update private.deployment_settings set turnstile_hostnames = '{"a.example,b.example"}' $$,
  '23514', null, 'and each element is one hostname');
select throws_ok($$ update private.deployment_settings set turnstile_hostnames = array['queue.example.com', null] $$,
  '23514', null, 'with no nulls');

select * from finish();
rollback;
