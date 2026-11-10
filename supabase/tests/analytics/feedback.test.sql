-- 2B-R7 (#298): api.feedback_summary and api.feedback_comments values, access and cross-tenant denial.
begin;
\ir ../helpers/_setup.psql
select plan(10);
select tests.create_world();

create function tests.fb(p_n int, p_rating int, p_nps int, p_comment text, p_service text default 'service_a')
returns uuid language plpgsql as $$
declare
  q app.queues := (select q from app.queues q where q.id = tests.id('queue_a'));
  vid uuid := gen_random_uuid();
begin
  perform private.set_actor('system', null);
  insert into app.visits (id, org_id, location_id, queue_id, service_id, service_day, ticket_prefix, ticket_number,
                          display_ticket, status, sort_key, guest_name, guest_token_hash, source, idempotency_key,
                          joined_at, called_at, serving_at, finished_at)
  values (vid, q.org_id, q.location_id, q.id, tests.id(p_service), '2026-03-02', 'F', p_n, 'F' || p_n, 'served', p_n, 'G',
          extensions.digest(gen_random_uuid()::text, 'sha256'), 'online', gen_random_uuid(),
          '2026-03-02 15:00+00', '2026-03-02 15:01+00', '2026-03-02 15:02+00', '2026-03-02 15:10+00');
  insert into app.visit_feedback (org_id, location_id, visit_id, rating, nps, comment, created_at)
  values (q.org_id, q.location_id, vid, p_rating, p_nps, p_comment, '2026-03-02 16:00+00'::timestamptz + make_interval(mins => p_n));
  return vid;
end $$;

alter table app.visits disable trigger user;
select tests.fb(1, 5, 10, 'great');
select tests.fb(2, 5, 9, null);
select tests.fb(3, 3, 7, 'ok');
select tests.fb(4, 1, 3, 'slow');
-- A fifth served visit whose guest left no feedback: it counts for the response rate only.
select tests.fb(5, 2, null, null);
delete from app.visit_feedback where visit_id = (select id from app.visits where display_ticket = 'F5');
alter table app.visits enable trigger user;

select tests.act_as('manager');
select results_eq($$ select responses, avg_rating, nps, promoters, passives, detractors
  from api.feedback_summary(tests.id('loc_a'), '2026-03-01', '2026-03-03', 'all') $$,
  $$ values (4, 3.5, 25.0, 2, 1, 1) $$, 'AC1: NPS answers 10, 9, 7, 3 give NPS 25');
select results_eq($$ select responses, served, rating_1, rating_2, rating_3, rating_4, rating_5
  from api.feedback_summary(tests.id('loc_a'), '2026-03-01', '2026-03-03', 'all') $$,
  $$ values (4, 5, 1, 0, 1, 0, 2) $$, 'AC1 (#299): 4 responses of 5 served, with the 1..5 distribution');
select results_eq($$ select grp, responses from api.feedback_summary(tests.id('loc_a'), '2026-03-01', '2026-03-03', 'week') $$,
  $$ values ('2026-03-02', 4) $$, 'weekly grouping keys on the Monday');
select results_eq($$ select grp from api.feedback_summary(tests.id('loc_a'), '2026-03-01', '2026-03-03', 'service') $$,
  $$ values ('Haircut') $$, 'service grouping uses the service name');
select results_eq($$ select ticket, service from api.feedback_comments(tests.id('loc_a'), '2026-03-01', '2026-03-03', 1, null) $$,
  $$ values ('F4', 'Haircut') $$, 'a comment carries its ticket and service for context');
select results_eq($$ select comment from api.feedback_comments(tests.id('loc_a'), '2026-03-01', '2026-03-03', 10, null) $$,
  $$ values ('slow'), ('ok'), ('great') $$, 'comments are newest first and skip empty ones');
select results_eq($$ select comment from api.feedback_comments(tests.id('loc_a'), '2026-03-01', '2026-03-03', 1,
    (select id from api.feedback_comments(tests.id('loc_a'), '2026-03-01', '2026-03-03', 1, null))) $$,
  $$ values ('ok') $$, 'p_after continues after the given row');

select tests.act_as('staff');
select throws_ok($$ select * from api.feedback_comments(tests.id('loc_a'), '2026-03-01', '2026-03-03', 10, null) $$,
  '42501', 'permission_denied', 'AC2: staff are denied the comments');
select throws_ok($$ select * from api.feedback_summary(tests.id('loc_a'), '2026-03-01', '2026-03-03', 'all') $$,
  '42501', 'permission_denied', 'and the summary');

select tests.act_as('other_owner');
select is_empty($$ select 1 from api.feedback_summary(tests.id('loc_a'), '2026-03-01', '2026-03-03', 'all') $$
  || ' union all select 1 from api.feedback_comments(tests.id(''loc_a''), ''2026-03-01'', ''2026-03-03'', 10, null)',
  'AC3: another org gets zero rows from both');

select * from finish();
rollback;
