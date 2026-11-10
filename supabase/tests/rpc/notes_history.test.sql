-- 2A-ST4 (#137): api.update_visit_notes and api.visit_history.
begin;
\ir ../helpers/_setup.psql
select plan(26);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_h'), tests.id('org_a'), tests.id('loc_a'), 'History', 'H');
select tests.new_visit('h1', 'queue_h', 'Hana');
select tests.new_visit('h2', 'queue_h', 'Hugo');
update app.memberships set display_name = 'Sam Staff' where user_id = tests.id('staff') and org_id = tests.id('org_a');

create function tests.ver(p_visit text) returns int language sql as $$
  select version from app.visits where id = tests.id(p_visit)
$$;
create function tests.note(p_visit text, p_notes text, p_tags text[]) returns api.visit_row language sql as $$
  select api.update_visit_notes(tests.id(p_visit), p_notes, p_tags, tests.ver(p_visit), gen_random_uuid())
$$;
grant execute on function tests.ver(text), tests.note(text, text, text[]) to authenticated;
create table tests.rows (name text primary key, r api.visit_row);
grant select, insert on tests.rows to authenticated;

------------------------------------------------------------------------------------------------
-- notes and tags
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
insert into tests.rows values ('n1', tests.note('h1', '  Allergic to latex, call 555-0100  ', array['VIP', ' vip ', 'late', '']));
select tests.as_postgres();
select is((select notes from app.visits where id = tests.id('h1')), 'Allergic to latex, call 555-0100', 'notes are saved, trimmed');
select is((select tags from app.visits where id = tests.id('h1')), array['VIP', 'late'], 'tags are trimmed and de-duplicated ignoring case');
select is((select payload from app.visit_events where id = (select (r).last_event_id from tests.rows where name = 'n1')),
  '{"changed": ["notes", "tags"]}'::jsonb, 'AC1: the event names the changed fields');
select is((select count(*)::int from app.visit_events where visit_id = tests.id('h1') and payload::text like '%latex%'), 0,
  'AC1: no event payload contains the note text');
select is((select type from app.visit_events where id = (select (r).last_event_id from tests.rows where name = 'n1')), 'notes_updated', 'the event type is notes_updated');

select tests.act_as('staff');
insert into tests.rows values ('n_same', tests.note('h1', 'Allergic to latex, call 555-0100', null));
select tests.as_postgres();
select is((select (r).last_event_id from tests.rows where name = 'n_same'), null::bigint, 'saving the same notes is a no-op without an event');
select tests.act_as('staff');
select tests.note('h1', '', array[]::text[]);
select tests.as_postgres();
select results_eq($$ select notes, tags from app.visits where id = tests.id('h1') $$, $$ values (null::text, '{}'::text[]) $$, 'empty clears notes and tags');

select tests.act_as('staff');
select throws_ok($$ select tests.note('h1', repeat('x', 1001), null) $$, 'P0001', 'invalid_input', 'notes over 1000 characters are refused');
select throws_ok($$ select tests.note('h1', null, (select array_agg('t' || g) from generate_series(1, 11) g)) $$, 'P0001', 'invalid_input', 'more than 10 distinct tags are refused');
select throws_ok($$ select tests.note('h1', null, array[repeat('x', 25)]) $$, 'P0001', 'invalid_input', 'a tag over 24 characters is refused');
select throws_ok(format($$ select api.update_visit_notes(%L, 'a', null, 99, gen_random_uuid()) $$, tests.id('h1')), 'P0001', 'stale_visit', 'a stale version raises stale_visit');
select tests.as_postgres();
select ok(not has_column_privilege('anon', 'app.visits', 'notes', 'SELECT'), 'anon cannot read notes');
select tests.act_as('staff');
select tests.note('h2', 'secret note', array['vip']);
select tests.as_postgres();
select tests.as_user(tests.id('other_owner'));
select is_empty($$ select 1 from app.visits where id = tests.id('h2') $$, 'staff of another org cannot read the visit or its notes');
select tests.as_postgres();
select is((private.anonymize_visits(tests.id('org_a'), array[tests.id('h2')])), 1, 'retention anonymizes the visit');
select is((select notes from app.visits where id = tests.id('h2')), null, 'and clears its notes');
select is((select tags from app.visits where id = tests.id('h2')), '{}'::text[], 'and its tags');
select tests.act_as('staff');
select throws_ok(format($$ select api.update_visit_notes(%L, 'late note', null, %s, gen_random_uuid()) $$, tests.id('h2'), tests.ver('h2')),
  'P0001', 'invalid_input', 'an anonymized visit takes no new notes');
select tests.as_postgres();

------------------------------------------------------------------------------------------------
-- history: joined, called, undone, called, started, served, one push sent
------------------------------------------------------------------------------------------------
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_k'), tests.id('org_a'), tests.id('loc_a'), 'Hist', 'K');
select tests.new_visit('k1', 'queue_k', 'Kim');
insert into app.push_subscriptions (id, org_id, visit_id, endpoint, p256dh, auth)
values (tests.new_id('push_k'), tests.id('org_a'), tests.id('k1'), 'https://push.example/k', 'k', 'a');
select tests.act_as('staff');
insert into tests.rows select 'call1', api.call_next(tests.id('queue_k'), null, gen_random_uuid());
insert into tests.rows select 'undo', api.undo_event((r).last_event_id, gen_random_uuid()) from tests.rows where name = 'call1';
select api.call_next(tests.id('queue_k'), null, gen_random_uuid());
select api.transition_visit(tests.id('k1'), 'start', tests.ver('k1'), gen_random_uuid());
select api.transition_visit(tests.id('k1'), 'complete', tests.ver('k1'), gen_random_uuid());
select tests.as_postgres();
create function tests.hist(p_visit text) returns setof api.visit_history_row language sql as $$
  select * from api.visit_history(tests.id(p_visit))
$$;
grant execute on function tests.hist(text) to authenticated;

select tests.act_as('staff');
select is((select string_agg(type, ',') from tests.hist('k1') where type <> 'notification'), 'joined,call,undo,call,start,complete',
  'AC2: the history lists the joined, call, undo, call, start and complete events');
select is((select string_agg(actor_label, ',') from tests.hist('k1') where type <> 'notification'), 'System,Sam Staff,Sam Staff,Sam Staff,Sam Staff,Sam Staff',
  'AC2: with actor names (the display name of the member)');
select cmp_ok((select count(*)::int from tests.hist('k1') where type = 'notification'), '>=', 1,
  'AC2: the push enqueued for the call is listed too');
select is((select (summary ->> 'undone')::boolean from tests.hist('k1') where type = 'call' limit 1), true, 'the undone call is flagged in its summary');
select is((select bool_and((summary - 'channel' - 'template' - 'status' - 'error_code') = '{}'::jsonb and summary ? 'channel')
           from tests.hist('k1') where type = 'notification'), true,
  'a notification shows channel, template and outcome only, never a recipient');
select tests.as_postgres();
update app.memberships set display_name = null where user_id = tests.id('staff') and org_id = tests.id('org_a');
create temp table expected_label as select split_part(email, '@', 1) as label from auth.users where id = tests.id('staff');
grant select on expected_label to authenticated;
select tests.act_as('staff');
select is((select actor_label from tests.hist('k1') where type = 'start'),
  (select label from expected_label), 'without a display name the label is the email before the @');

select tests.act_as('other_owner');
select throws_ok(format($$ select * from api.visit_history(%L) $$, tests.id('k1')), 'P0001', 'not_found', 'AC3: staff of org B get not_found');
select throws_ok(format($$ select api.update_visit_notes(%L, 'x', null, 0, gen_random_uuid()) $$, tests.id('k1')), 'P0001', 'not_found', 'and for notes');
select tests.as_anon();
select throws_ok(format($$ select * from api.visit_history(%L) $$, tests.id('k1')), '42501', null, 'anon cannot read history');

select * from finish();
rollback;
