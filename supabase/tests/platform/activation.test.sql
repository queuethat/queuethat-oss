-- #1129: tenant activation funnel. Stages are derived from existing rows; support and operator
-- read them, nobody else can, and no guest data leaves.
begin;
\ir ../helpers/_setup.psql
select plan(73);

select tests.create_world();
select tests.create_user('support');
insert into app.platform_roles (user_id, role) values (tests.id('support'), 'support');
create function tests.as_operator() returns void
language sql as $$ select tests.as_user(tests.id('platform'), '{"aal":"aal2"}') $$;
create function tests.as_support() returns void
language sql as $$ select tests.as_user(tests.id('support'), '{"aal":"aal2"}') $$;
grant execute on function tests.as_operator(), tests.as_support() to authenticated;

-- The world's two orgs are created "now"; every synthetic org below is 1-20 days old, so the
-- funnel window (ending yesterday) excludes the world.

/** An org created p_age days ago whose name is also its fixture id. */
create function tests.mk_org(p_name text, p_age int) returns uuid language sql as $$
  insert into app.organizations (id, name, created_at)
  values (tests.new_id(p_name), p_name, now() - make_interval(days => p_age)) returning id
$$;
create function tests.mk_loc(p_org text, p_age int) returns uuid language sql as $$
  insert into app.locations (id, org_id, name, slug, tz, created_at)
  values (tests.new_id(p_org || '_loc'), tests.id(p_org), 'Loc', 'act-' || replace(p_org, '_', '-'), 'Pacific/Auckland',
          now() - make_interval(days => p_age)) returning id
$$;
create function tests.mk_queue(p_org text, p_age int, p_state api.queue_state, p_archived boolean default false)
returns uuid language sql as $$
  insert into app.queues (id, org_id, location_id, name, ticket_prefix, manual_state, archived_at, created_at)
  values (tests.new_id(p_org || '_q'), tests.id(p_org), tests.id(p_org || '_loc'), 'Q', 'A', p_state,
          case when p_archived then now() end, now() - make_interval(days => p_age)) returning id
$$;
/** A visit of p_org joined p_joined days ago; p_served_ago non-null makes it served then. */
create function tests.mk_visit(p_org text, p_joined int, p_served_ago int default null) returns void
language plpgsql as $$
begin
  perform tests.new_visit(p_org || '_v', p_org || '_q', 'Secret Guestname');
  if p_served_ago is not null then
    perform private.set_actor('system', null, 'call');
    update app.visits set status = 'called' where id = tests.id(p_org || '_v');
    perform private.set_actor('system', null, 'start');
    update app.visits set status = 'serving' where id = tests.id(p_org || '_v');
    perform private.set_actor('system', null, 'complete');
    update app.visits set status = 'served' where id = tests.id(p_org || '_v');
  end if;
  perform private.set_actor('system', null);
  update app.visits set joined_at = now() - make_interval(days => p_joined),
                        finished_at = case when p_served_ago is not null
                                           then now() - make_interval(days => p_served_ago) end
  where id = tests.id(p_org || '_v');
end $$;

select tests.mk_org('act_empty', 10);               -- a business row and nothing else
select tests.mk_org('act_loc', 12);
select tests.mk_loc('act_loc', 11);
select tests.mk_org('act_queue', 9);
select tests.mk_loc('act_queue', 9);
select tests.mk_queue('act_queue', 8, 'closed');
select tests.mk_org('act_live', 8);
select tests.mk_loc('act_live', 8);
select tests.mk_queue('act_live', 7, 'open');
select tests.mk_org('act_guest', 7);
select tests.mk_loc('act_guest', 7);
select tests.mk_queue('act_guest', 6, 'open');
select tests.mk_visit('act_guest', 5);
select tests.mk_org('act_served', 6);
select tests.mk_loc('act_served', 6);
select tests.mk_queue('act_served', 5, 'open');
select tests.mk_visit('act_served', 3, 2);
select tests.mk_org('act_recent', 1);               -- too new to be stuck
select tests.mk_org('act_susp', 15);
update app.organizations set status = 'suspended', suspended_reason = 'x', suspended_at = now() where id = tests.id('act_susp');
select tests.mk_org('act_implied', 10);             -- a visit exists though the queue is archived and closed
select tests.mk_loc('act_implied', 10);
select tests.mk_queue('act_implied', 9, 'closed', true);
select tests.mk_visit('act_implied', 4);
-- A founder whose account is older than the business.
select tests.create_user('act_founder');
update auth.users set created_at = now() - interval '30 days' where id = tests.id('act_founder');
insert into app.memberships (org_id, user_id, role, created_at)
values (tests.id('act_loc'), tests.id('act_founder'), 'owner', now() - interval '12 days');
-- Side milestones.
insert into app.invitations (org_id, email, role, token_hash, created_at, accepted_at)
values (tests.id('act_served'), 'inv@test.local', 'staff', extensions.digest('t1', 'sha256'),
        now() - interval '2 days', now() - interval '1 day'),
       (tests.id('act_empty'), 'pending@test.local', 'staff', extensions.digest('t2', 'sha256'), now(), null);
insert into app.subscriptions (org_id, stripe_subscription_id, status, updated_at)
values (tests.id('act_served'), 'sub_1', 'active', now() - interval '1 day'),
       (tests.id('act_empty'), 'sub_2', 'incomplete', now()),
       (tests.id('act_recent'), 'sub_3', 'canceled', now() - interval '12 hours')
on conflict (org_id) do update set stripe_subscription_id = excluded.stripe_subscription_id,
  status = excluded.status, updated_at = excluded.updated_at;

create function tests.act(p text) returns api.platform_activation language sql stable as $$
  select a from api.platform_org_activation(array[tests.id(p)]) a
$$;
create temp table act_all (like api.platform_activation);
grant all on act_all to authenticated;
select tests.as_operator();
insert into act_all select * from api.platform_org_activation(array[
  tests.id('act_empty'), tests.id('act_loc'), tests.id('act_queue'), tests.id('act_live'), tests.id('act_guest'),
  tests.id('act_served'), tests.id('act_recent'), tests.id('act_susp'), tests.id('act_implied')]);
select tests.as_postgres();

-- Stage derivation (as postgres: the functions are checked under roles further down).
select results_eq($$ select stage, next_stage, stuck_days, is_stuck from act_all where org_id = tests.id('act_empty') $$,
  $$ values ('business_created', 'location_added', 10, true) $$, 'an empty tenant is at business_created, stuck since signup');
select results_eq($$ select stage, next_stage, stuck_days, is_stuck from act_all where org_id = tests.id('act_loc') $$,
  $$ values ('location_added', 'queue_created', 11, true) $$, 'a location moves it to location_added; the clock restarts');
select results_eq($$ select stage, next_stage, stuck_days from act_all where org_id = tests.id('act_queue') $$,
  $$ values ('queue_created', 'line_live', 8) $$, 'a closed queue is queue_created, not line_live');
select results_eq($$ select stage, next_stage, stuck_days from act_all where org_id = tests.id('act_live') $$,
  $$ values ('line_live', 'first_guest', 7) $$, 'an open queue is line_live');
select results_eq($$ select stage, next_stage, stuck_days from act_all where org_id = tests.id('act_guest') $$,
  $$ values ('first_guest', 'first_served', 5) $$, 'a visit that is still waiting is first_guest');
select results_eq($$ select stage, next_stage, stuck_days, is_stuck from act_all where org_id = tests.id('act_served') $$,
  $$ values ('first_served', null::text, null::int, false) $$, 'a served visit is first_served: nothing pending, not stuck');
select results_eq($$ select stage, stuck_days, is_stuck from act_all where org_id = tests.id('act_recent') $$,
  $$ values ('business_created', 1, false) $$, 'one day is below the 3-day threshold');
select is(private.activation_stuck_days(), 3, 'the threshold is 3 days');
select results_eq($$ select stage, stuck_days, is_stuck from act_all where org_id = tests.id('act_susp') $$,
  $$ values ('business_created', 15, false) $$, 'a suspended org has days but is never flagged stuck');
select results_eq($$ select stage, stuck_days from act_all where org_id = tests.id('act_implied') $$,
  $$ values ('first_guest', 4) $$, 'a visit implies the line was live even if the queue is archived and closed');
select is((select s ->> 'reached_at' from act_all a, jsonb_array_elements(a.stages) s
           where a.org_id = tests.id('act_implied') and s ->> 'stage' = 'line_live')::timestamptz,
          (select joined_at from app.visits where id = tests.id('act_implied_v')),
  'the implied stage is dated at the first visit');
select results_eq(
  $$ select s ->> 'stage' from act_all a, jsonb_array_elements(a.stages) s
     where a.org_id = tests.id('act_implied') and s ->> 'reached_at' is not null order by 1 $$,
  $$ values ('business_created'), ('first_guest'), ('line_live'), ('location_added'), ('queue_created'), ('signed_up') $$,
  'only reached stages carry a time');
select is((select jsonb_array_length(stages) from act_all limit 1), 9, 'every row lists all nine stages');
select is((select s ->> 'reached_at' from act_all a, jsonb_array_elements(a.stages) s
           where a.org_id = tests.id('act_loc') and s ->> 'stage' = 'signed_up')::timestamptz,
          now() - interval '30 days', 'signed_up is the founding member''s account when it predates the org');
select is((select s ->> 'reached_at' from act_all a, jsonb_array_elements(a.stages) s
           where a.org_id = tests.id('act_empty') and s ->> 'stage' = 'signed_up')::timestamptz,
          now() - interval '10 days', 'an org with no members signs up when it is created');
select is((select s ->> 'reached_at' from act_all a, jsonb_array_elements(a.stages) s
           where a.org_id = tests.id('act_served') and s ->> 'stage' = 'staff_invite_accepted')::timestamptz,
          now() - interval '1 day', 'side milestone: an accepted invitation (a pending one does not count)');
select ok((select s ->> 'reached_at' is null from act_all a, jsonb_array_elements(a.stages) s
           where a.org_id = tests.id('act_empty') and s ->> 'stage' in ('staff_invite_accepted')),
  'a pending invitation is not an accepted one');
select ok((select s ->> 'reached_at' is not null from act_all a, jsonb_array_elements(a.stages) s
           where a.org_id = tests.id('act_served') and s ->> 'stage' = 'card_on_file'), 'an active subscription is card_on_file');
select ok((select s ->> 'reached_at' is not null from act_all a, jsonb_array_elements(a.stages) s
           where a.org_id = tests.id('act_recent') and s ->> 'stage' = 'card_on_file'), 'a canceled subscription still had a card');
select ok((select s ->> 'reached_at' is null from act_all a, jsonb_array_elements(a.stages) s
           where a.org_id = tests.id('act_empty') and s ->> 'stage' = 'card_on_file'), 'an incomplete subscription is not card_on_file');

-- Orphan accounts: signed up in the window, never created or joined a business.
select tests.create_user('act_orphan');
update auth.users set created_at = now() - interval '5 days' where id = tests.id('act_orphan');
select tests.create_user('act_orphan_old');
update auth.users set created_at = now() - interval '40 days' where id = tests.id('act_orphan_old');
select tests.create_user('act_orphan_invited');
update auth.users set created_at = now() - interval '5 days' where id = tests.id('act_orphan_invited');
insert into app.invitations (org_id, email, role, token_hash)
values (tests.id('act_empty'), 'act_orphan_invited@test.local', 'staff', extensions.digest('t3', 'sha256'));

-- Funnel over the synthetic window: 20 days ago .. yesterday (UTC).
create temp table fun (r api.platform_funnel_result);
grant all on fun to authenticated;
select tests.as_operator();
insert into fun select api.platform_funnel(((now() at time zone 'UTC')::date - 20), ((now() at time zone 'UTC')::date - 1));
select tests.as_postgres();
create function tests.stage_count(p text) returns bigint language sql stable as $$
  select (s ->> 'count')::bigint from fun, jsonb_array_elements((r).stages) s where s ->> 'stage' = p
$$;
create function tests.stage_ratio(p text, k text) returns numeric language sql stable as $$
  select (s ->> k)::numeric from fun, jsonb_array_elements((r).stages) s where s ->> 'stage' = p
$$;
select results_eq(
  $$ select s ->> 'stage', (s ->> 'count')::int from fun, jsonb_array_elements((r).stages) s $$,
  $$ values ('signed_up', 10), ('business_created', 9), ('location_added', 6), ('queue_created', 5),
            ('line_live', 4), ('first_guest', 3), ('first_served', 1), ('staff_invite_accepted', 1),
            ('card_on_file', 2) $$,
  'funnel counts per stage, in order; signed_up includes the one orphan account');
select is((select (r).signups_without_business from fun), 1,
  'orphans: only accounts in the window with no membership, no platform role and no live invitation');
select is(tests.stage_ratio('signed_up', 'conversion_prev'), null, 'signed_up has no previous stage');
select is(tests.stage_ratio('business_created', 'conversion_prev'), 0.9, 'conversion signup to business');
select is(tests.stage_ratio('location_added', 'conversion_prev'), 0.6667, 'conversion business to location');
select is(tests.stage_ratio('first_served', 'conversion_prev'), 0.3333, 'conversion first_guest to first_served');
select is(tests.stage_ratio('first_served', 'conversion_start'), 0.1, 'conversion from the start');
select is(tests.stage_ratio('card_on_file', 'conversion_prev'), 0.2, 'side milestones are measured against signups');
select is((select (r).from_date from fun), (now() at time zone 'UTC')::date - 20, 'the range is echoed back');
select is((select (r).stuck_total from fun), 6, 'six active tenants are stuck before first_served');
select results_eq(
  $$ select x ->> 'name', x ->> 'stage', (x ->> 'stuck_days')::int
     from fun, jsonb_array_elements((r).stuck) x $$,
  $$ values ('act_loc', 'location_added', 11), ('act_empty', 'business_created', 10),
            ('act_queue', 'queue_created', 8), ('act_live', 'line_live', 7),
            ('act_guest', 'first_guest', 5), ('act_implied', 'first_guest', 4) $$,
  'AC: every tenant stuck before first_served, longest first, with days stuck; served, recent and suspended are absent');
select ok((select to_jsonb(r)::text not like '%Secret Guestname%' from fun), 'no guest name anywhere in the funnel');
select is((select x ->> 'org_id' from fun, jsonb_array_elements((r).stuck) x where x ->> 'name' = 'act_loc'),
  tests.id('act_loc')::text, 'a stuck row carries the org id the console links to');

-- Empty range, stage filter, paging boundaries.
select tests.as_support();
select results_eq($$ select (r).stuck_total, jsonb_array_length((r).stuck), (r).signups_without_business
                     from (select api.platform_funnel('2000-01-01', '2000-01-02') r) f $$,
  $$ values (0, 0, 0) $$, 'a range with no tenants is empty, not an error');
select is((select (s ->> 'conversion_start') is null from (select api.platform_funnel('2000-01-01', '2000-01-02') r) f,
           jsonb_array_elements((r).stages) s where s ->> 'stage' = 'first_served'), true,
  'conversions are null when there is nothing to divide by');
select is((select (r).stuck_total from (select api.platform_funnel(now()::date - 20, now()::date - 1, 'line_live') r) f), 1,
  'the stage filter narrows the stuck list');
select is((select jsonb_array_length((r).stuck) from (select api.platform_funnel(now()::date - 20, now()::date - 1, null, 2, 0) r) f), 2, 'page 1 has 2');
select is((select (r).stuck -> 0 ->> 'name' from (select api.platform_funnel(now()::date - 20, now()::date - 1, null, 2, 2) r) f), 'act_queue',
  'page 2 starts where page 1 ended');
select is((select jsonb_array_length((r).stuck) from (select api.platform_funnel(now()::date - 20, now()::date - 1, null, 2, 4) r) f), 2, 'the last full page');
select is((select jsonb_array_length((r).stuck) from (select api.platform_funnel(now()::date - 20, now()::date - 1, null, 2, 6) r) f), 0,
  'an offset exactly at the end is an empty page');
select is((select (r).stuck_total from (select api.platform_funnel(now()::date - 20, now()::date - 1, null, 2, 100) r) f), 6,
  'stuck_total does not depend on the page');
select is((select jsonb_array_length((r).stuck) from (select api.platform_funnel(now()::date - 20, now()::date - 1, null, 200, 0) r) f), 6, 'p_limit 200 is allowed');
select throws_ok($$ select api.platform_funnel(null, null, null, 201) $$, 'P0001', 'invalid_input', 'p_limit 201 is rejected');
select throws_ok($$ select api.platform_funnel(null, null, null, 0) $$, 'P0001', 'invalid_input', 'p_limit 0 is rejected');
select throws_ok($$ select api.platform_funnel(null, null, null, 50, -1) $$, 'P0001', 'invalid_input', 'a negative offset is rejected');
select throws_ok($$ select api.platform_funnel(null, null, 'first_served') $$, 'P0001', 'invalid_input', 'first_served is not a stuck stage');
select throws_ok($$ select api.platform_funnel(null, null, 'bogus') $$, 'P0001', 'invalid_input', 'an unknown stage is rejected');
select throws_ok($$ select api.platform_funnel('2026-02-02', '2026-02-01') $$, 'P0001', 'invalid_input', 'from after to is rejected');
select is((select (r).to_date - (r).from_date from (select api.platform_funnel() r) f), 29, 'the default range is 30 UTC days');
select is((select (r).from_date from (select api.platform_funnel(null, '2026-03-31') r) f), '2026-03-02'::date, 'a lone p_to gives the 30 days before it');

-- Timezones: tenants are bucketed by UTC calendar day whatever the session zone, both ends inclusive.
select tests.as_postgres();
insert into app.organizations (id, name, created_at) values
  (tests.new_id('edge_in'), 'edge_in', '2026-01-10 23:59:59+00'),
  (tests.new_id('edge_out'), 'edge_out', '2026-01-11 00:00:00+00'),
  (tests.new_id('edge_first'), 'edge_first', '2026-01-10 00:00:00+00');
select tests.as_support();
set local timezone = 'Pacific/Auckland';
select is((select (s ->> 'count')::int from (select api.platform_funnel('2026-01-10', '2026-01-10') r) f,
           jsonb_array_elements((r).stages) s where s ->> 'stage' = 'business_created'), 2,
  'UTC day 2026-01-10 holds its first and last second, in Auckland time');
set local timezone = 'America/Los_Angeles';
select is((select (s ->> 'count')::int from (select api.platform_funnel('2026-01-10', '2026-01-10') r) f,
           jsonb_array_elements((r).stages) s where s ->> 'stage' = 'business_created'), 2,
  'and in Los Angeles time');
select is((select (s ->> 'count')::int from (select api.platform_funnel('2026-01-10', '2026-01-11') r) f,
           jsonb_array_elements((r).stages) s where s ->> 'stage' = 'business_created'), 3, 'the end date is inclusive');
set local timezone = 'UTC';

-- Per-org lookup: bounds, unknown and duplicate ids.
select is((select count(*) from api.platform_org_activation(array[tests.id('act_loc'), tests.id('act_loc')])), 1::bigint,
  'a repeated id returns one row');
select is((select count(*) from api.platform_org_activation(array[gen_random_uuid()])), 0::bigint, 'an unknown id is left out');
select is((select count(*) from api.platform_org_activation((select array_agg(gen_random_uuid()) from generate_series(1, 200)))), 0::bigint,
  '200 ids are allowed');
select throws_ok($$ select * from api.platform_org_activation((select array_agg(gen_random_uuid()) from generate_series(1, 201))) $$,
  'P0001', 'invalid_input', '201 ids are rejected');
select throws_ok($$ select * from api.platform_org_activation('{}') $$, 'P0001', 'invalid_input', 'an empty list is rejected');
select throws_ok($$ select * from api.platform_org_activation(null) $$, 'P0001', 'invalid_input', 'null is rejected');

-- Grants never matter: an expired and a revoked support grant leave the answer unchanged.
create temp table before_grants (j jsonb);
grant all on before_grants to authenticated;
select tests.as_operator();
insert into before_grants select to_jsonb(a) from api.platform_org_activation(array[tests.id('act_guest')]) a;
select tests.as_postgres();
insert into app.support_grants (org_id, scope, reason, created_at, expires_at, revoked_at)
values (tests.id('act_guest'), 'read', 'old', now() - interval '2 hours', now() - interval '1 hour', null),
       (tests.id('act_guest'), 'act', 'revoked', now() - interval '1 hour', now() + interval '1 hour', now());
select tests.as_support();
select is((select to_jsonb(a) from api.platform_org_activation(array[tests.id('act_guest')]) a), (select j from before_grants),
  'support reads activation with no live grant, and expired or revoked grants change nothing');

-- Access: support and operator read; everyone else is denied, MFA included.
select tests.as_operator();
select is((select count(*) from api.platform_org_activation(array[tests.id('act_loc')])), 1::bigint, 'an operator can read activation');
select lives_ok($$ select api.platform_funnel() $$, 'an operator can read the funnel');
select tests.as_support();
select lives_ok($$ select api.platform_funnel() $$, 'support can read the funnel');
select tests.as_user(tests.id('platform'), '{"aal":"aal1"}');
select throws_ok($$ select api.platform_funnel() $$, '42501', 'permission_denied', 'an operator without MFA is denied the funnel');
select throws_ok($$ select * from api.platform_org_activation(array[tests.id('act_loc')]) $$, '42501', 'permission_denied',
  'and activation');
select tests.as_user(tests.id('support'), '{"aal":"aal1"}');
select throws_ok($$ select api.platform_funnel() $$, '42501', 'permission_denied', 'support without MFA is denied');
-- Cross-tenant: owners of org A and org B, and staff, see nothing of any tenant.
select tests.as_user(tests.id('owner'), '{"aal":"aal2"}');
select throws_ok($$ select api.platform_funnel() $$, '42501', 'permission_denied', 'an org owner is denied the funnel');
select throws_ok($$ select * from api.platform_org_activation(array[tests.id('org_a')]) $$, '42501', 'permission_denied',
  'an owner is denied activation even of their own org');
select tests.as_user(tests.id('other_owner'), '{"aal":"aal2"}');
select throws_ok($$ select * from api.platform_org_activation(array[tests.id('org_a')]) $$, '42501', 'permission_denied',
  'cross-tenant: another org''s owner is denied');
select tests.as_user(tests.id('staff'), '{"aal":"aal2"}');
select throws_ok($$ select api.platform_funnel() $$, '42501', 'permission_denied', 'staff are denied');
select tests.as_anon();
select throws_ok($$ select api.platform_funnel() $$, '42501', null, 'anon is denied the funnel');
select throws_ok($$ select * from api.platform_org_activation(array[tests.id('org_a')]) $$, '42501', null, 'anon is denied activation');
select tests.as_postgres();
select is((select count(*) from information_schema.routine_privileges
           where routine_schema = 'private' and routine_name in ('org_activation', 'activation_stuck_days')
             and grantee in ('anon', 'authenticated', 'public')), 0::bigint, 'the helpers are not callable through the API');

select * from finish();
rollback;
