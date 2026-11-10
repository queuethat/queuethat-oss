-- PLT2 (#408): a suspended org's staff and devices cannot write, new joins are rejected, waiting
-- guests keep their status page, and setting the org back to active restores everything.
begin;
\ir ../helpers/_setup.psql
select plan(24);
select tests.create_world();

-- loc_a open all day; a guest is waiting before the suspension.
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
create table tests.tokens (name text primary key, token text);
grant all on tests.tokens to anon, authenticated;
select tests.as_anon();
insert into tests.tokens
  select 'ann', (api.join_queue(tests.id('queue_a'), null, 'Ann', null, null, 1, 'en', gen_random_uuid())).token;
select tests.as_postgres();

create function tests.set_status(p_status app.org_status) returns void
language sql as $$ update app.organizations set status = p_status where id = tests.id('org_a') $$;

/** Runs p_sql as p_actor and rolls it back: 'allow' when it returned rows, else 'deny: <error>'. */
create function tests.try(p_actor text, p_sql text) returns text
language plpgsql as $$
declare n bigint; r text;
begin
  begin
    if p_actor = 'anon' then perform tests.as_anon(); else perform tests.act_as(p_actor); end if;
    execute p_sql into n;
    raise exception using errcode = 'QMPRB', message = case when n > 0 then 'allow' else 'deny: no rows' end;
  exception
    when sqlstate 'QMPRB' then r := sqlerrm;
    when others then r := 'deny: ' || sqlerrm;
  end;
  return r;
end $$;

/** Every check from the acceptance criteria, as (check, outcome) rows. */
create function tests.suspension_checks() returns table (check_name text, outcome text)
language plpgsql as $$
declare
  ann text := (select token from tests.tokens where name = 'ann');
begin
  check_name := 'staff call_next';
  outcome := tests.try('staff', $q$ select count(*) from api.call_next(tests.id('queue_a'), null, gen_random_uuid()) $q$);
  return next;
  check_name := 'owner call_next';
  outcome := tests.try('owner', $q$ select count(*) from api.call_next(tests.id('queue_a'), null, gen_random_uuid()) $q$);
  return next;
  check_name := 'owner selects locations';
  outcome := tests.try('owner', $q$ select count(*) from app.locations where org_id = tests.id('org_a') $q$);
  return next;
  check_name := 'staff selects locations';
  outcome := tests.try('staff', $q$ select count(*) from app.locations where org_id = tests.id('org_a') $q$);
  return next;
  check_name := 'admin updates a location';
  outcome := tests.try('admin', $q$ with x as (update app.locations set name = name where id = tests.id('loc_a') returning 1) select count(*) from x $q$);
  return next;
  check_name := 'display reads its snapshot';
  outcome := tests.try('display', $q$ select count(*) from api.display_snapshot(tests.id('loc_a')) $q$);
  return next;

  check_name := 'staff set_queue_state';
  outcome := tests.try('staff', $q$ select count(*) from api.set_queue_state(tests.id('queue_a'), 'paused') $q$);
  return next;
  check_name := 'kiosk joins';
  outcome := tests.try('kiosk', $q$ select count(*) from api.join_queue(tests.id('queue_a'), null, 'Kim', null, null, 1, 'en', gen_random_uuid()) $q$);
  return next;
  check_name := 'guest joins';
  outcome := tests.try('anon', $q$ select count(*) from api.join_queue(tests.id('queue_a'), null, 'Gus', null, null, 1, 'en', gen_random_uuid()) $q$);
  return next;

  perform tests.as_anon();
  check_name := 'waiting guest status';
  outcome := (api.get_visit_status(ann)).status::text;
  return next;
  check_name := 'join page';
  select coalesce(q.not_accepting_reason, 'accepting') into outcome
  from unnest((api.get_location_public('test-location-a')).queues) q where q.id = tests.id('queue_a');
  return next;
  perform tests.as_postgres();
end $$;

select tests.set_status('suspended');
create temp table suspended as select * from tests.suspension_checks();
select tests.set_status('active');
create temp table restored as select * from tests.suspension_checks();

-- AC1
select is((select outcome from suspended where check_name = 'staff call_next'), 'deny: org_suspended',
  'AC1: staff of a suspended org cannot call_next (42501 org_suspended)');
select is((select outcome from suspended where check_name = 'owner call_next'), 'deny: org_suspended',
  'an owner of a suspended org cannot call_next either');
select is((select outcome from suspended where check_name = 'owner selects locations'), 'allow',
  'AC1: an owner of a suspended org still reads their locations');
select is((select outcome from suspended where check_name = 'staff selects locations'), 'allow',
  'staff of a suspended org still read, so the UI can say why');
select is((select outcome from suspended where check_name = 'admin updates a location'), 'deny: no rows',
  'config writes stop for a suspended org');
select is((select outcome from suspended where check_name = 'display reads its snapshot'), 'deny: not_found',
  'a display of a suspended org stops');
select is((select outcome from suspended where check_name = 'staff set_queue_state'), 'deny: org_suspended',
  'staff of a suspended org cannot open, pause or close queues');
-- AC2
select is((select outcome from suspended where check_name = 'guest joins'), 'deny: org_suspended',
  'AC2: a guest join to a suspended org raises org_suspended');
select is((select outcome from suspended where check_name = 'waiting guest status'), 'waiting',
  'AC2: a guest already waiting still gets their status');
select is((select outcome from suspended where check_name = 'join page'), 'org_suspended',
  'the join page shows the queue as not accepting with reason org_suspended');
-- AC3
select is((select outcome from suspended where check_name = 'kiosk joins'), 'deny: not_found',
  'AC3: a kiosk of a suspended org cannot join');

-- AC4: back to active, every check succeeds again.
select is((select outcome from restored where check_name = 'staff call_next'), 'allow', 'AC4: staff call_next works again');
select is((select outcome from restored where check_name = 'owner call_next'), 'allow', 'AC4: owner call_next works again');
select is((select outcome from restored where check_name = 'staff selects locations'), 'allow', 'AC4: staff read again');
select is((select outcome from restored where check_name = 'admin updates a location'), 'allow', 'AC4: config writes work again');
select is((select outcome from restored where check_name = 'display reads its snapshot'), 'allow', 'AC4: the display works again');
select is((select outcome from restored where check_name = 'staff set_queue_state'), 'allow', 'AC4: queue state changes work again');
select is((select outcome from restored where check_name = 'kiosk joins'), 'allow', 'AC4: the kiosk joins again');
select is((select outcome from restored where check_name = 'guest joins'), 'allow', 'AC4: guests join again');
select is((select outcome from restored where check_name = 'join page'), 'accepting', 'AC4: the join page accepts again');

-- Guests and the system still change visits of a suspended org; staff do not.
select tests.set_status('suspended');
select tests.as_anon();
select is((api.guest_act((select token from tests.tokens where name = 'ann'), 'leave', gen_random_uuid())).status::text,
  'cancelled', 'a waiting guest of a suspended org can still leave');
select tests.as_postgres();
select throws_ok($$ select private.set_actor('staff', tests.id('owner'), 'no_show');
                    update app.visits set status = 'no_show' where id = tests.id('visit_a') $$,
  '42501', 'org_suspended', 'the visit guard rejects staff writes in a suspended org');
select lives_ok($$ select private.set_actor('system', null, 'expire');
                   update app.visits set status = 'expired' where id = tests.id('visit_a') $$,
  'the system can still expire visits of a suspended org');
select tests.set_status('pending_deletion');
select tests.as_anon();
select throws_ok($$ select api.join_queue(tests.id('queue_a'), null, 'Pam', null, null, 1, 'en', gen_random_uuid()) $$,
  'P0001', 'org_suspended', 'pending_deletion is enforced like suspended');

select * from finish();
rollback;
