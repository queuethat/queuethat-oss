-- 2B-G1 (#247): app.visit_feedback and api.guest_submit_feedback.
begin;
\ir ../helpers/_setup.psql
select plan(17);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

create table tests.tokens (name text primary key, token text, visit_id uuid);
grant select on all tables in schema tests to anon, authenticated;
grant insert on tests.tokens to anon;

select tests.as_anon();
insert into tests.tokens (name, token)
  select n, (api.join_queue(tests.id('queue_a'), null, n, null, null, 1, 'en', gen_random_uuid())).token
  from unnest(array['served', 'waiting', 'old', 'noshow']) n;
select tests.as_postgres();
update tests.tokens t set visit_id = v.id from app.visits v where v.guest_token_hash = private.token_hash(t.token);

create function tests.finish(p_name text, p_status text, p_ago interval) returns void language plpgsql as $$
declare vid uuid := (select visit_id from tests.tokens where name = p_name);
begin
  perform private.set_actor('system', null, 'call');
  update app.visits set status = 'called', called_at = now() where id = vid;
  if p_status = 'served' then
    perform private.set_actor('system', null, 'start');
    update app.visits set status = 'serving', serving_at = now() where id = vid;
    perform private.set_actor('system', null, 'complete');
    update app.visits set status = 'served', finished_at = now() - p_ago where id = vid;
  else
    perform private.set_actor('system', null, 'no_show');
    update app.visits set status = 'no_show', finished_at = now() - p_ago where id = vid;
  end if;
end $$;
select tests.finish('served', 'served', interval '1 hour');
select tests.finish('old', 'served', interval '25 hours');
select tests.finish('noshow', 'no_show', interval '1 hour');

create function tests.fb(p_name text, p_rating int, p_nps int default null, p_comment text default null)
returns api.feedback_result language sql as $$
  select api.guest_submit_feedback((select token from tests.tokens where name = p_name), p_rating, p_nps, p_comment, gen_random_uuid())
$$;

grant execute on function tests.fb(text, int, int, text) to anon;

-- AC1
select tests.as_anon();
select results_eq($$ select (r).submitted, (r).already_submitted from (select tests.fb('served', 4, 9, '  Great  ') r) x $$,
  $$ values (true, false) $$, 'AC1: a served visit stores feedback');
select results_eq($$ select (r).submitted, (r).already_submitted from (select tests.fb('served', 1, 0, 'Worse') r) x $$,
  $$ values (false, true) $$, 'AC1: a second submission returns already_submitted');
select tests.as_postgres();
select results_eq($$ select rating::int, nps, comment::text from app.visit_feedback where visit_id in (select visit_id from tests.tokens) $$, $$ values (4, null::smallint, 'Great') $$,
  'one row, first answer kept, comment trimmed, NPS dropped while the org does not ask');
update app.organizations set feedback_ask_nps = true where id = tests.id('org_a');
select tests.as_anon();
select throws_ok($$ select tests.fb('served', 6) $$, 'P0001', 'invalid_input', 'rating above 5 is invalid');
select throws_ok($$ select tests.fb('served', 0) $$, 'P0001', 'invalid_input', 'rating below 1 is invalid');
select throws_ok($$ select tests.fb('served', 3, 11) $$, 'P0001', 'invalid_input', 'NPS above 10 is invalid');
select throws_ok($$ select tests.fb('served', 3, 5, repeat('x', 1001)) $$, 'P0001', 'invalid_input', 'a comment over 1000 characters is invalid');

-- AC2
select throws_ok($$ select tests.fb('waiting', 5) $$, 'P0001', 'not_found', 'AC2: a waiting visit is not_found');
select throws_ok($$ select tests.fb('old', 5) $$, 'P0001', 'not_found', 'AC2: a visit ended 25 h ago is not_found');
select throws_ok($$ select api.guest_submit_feedback('nope', 5, null, null, gen_random_uuid()) $$, 'P0001', 'not_found', 'unknown token is not_found');
select throws_ok($$ select tests.fb('noshow', 5) $$, 'P0001', 'not_found', 'no_show is not_found by default');
select tests.as_postgres();
update app.organizations set feedback_include_no_show = true where id = tests.id('org_a');
select tests.as_anon();
select lives_ok($$ select tests.fb('noshow', 2) $$, 'no_show accepted when the org allows it');
select tests.as_postgres();
update app.organizations set feedback_enabled = false where id = tests.id('org_a');
select tests.as_anon();
select throws_ok($$ select tests.fb('served', 5) $$, 'P0001', 'not_found', 'feedback off is not_found');

-- AC3
select tests.act_as('staff');
select is((select count(*)::int from app.visit_feedback where visit_id in (select visit_id from tests.tokens)), 2, 'staff of the location read feedback');
select tests.as_user(tests.id('other_owner'));
select is((select count(*)::int from app.visit_feedback), 0, 'AC3: staff of org B see zero rows');

-- AC4
select tests.as_postgres();
update app.visit_feedback set created_at = now() - interval '91 days' where rating = 4;
update app.visit_feedback set comment = null where visit_id = tests.id('visit_a');
select is(ops.feedback_retention_tick(), 1, 'AC4: the job clears one old comment');
select results_eq($$ select rating::int, comment::text from app.visit_feedback where rating = 4 $$, $$ values (4, null::text) $$,
  'AC4: the rating remains');

select * from finish();
rollback;
