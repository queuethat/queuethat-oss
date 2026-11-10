-- Operator/staff session limits: a signed-in person is signed out 12 hours after signing in, or
-- after 30 minutes without activity. Paired displays and kiosks are unattended and exempt.
begin;
\ir ../helpers/_setup.psql
select plan(17);
select tests.create_world();

select tests.create_user('absolute');
select tests.create_user('idle');
select tests.create_user('active');
select tests.create_user('fresh');
select tests.create_user('stale_new');
select tests.create_user('tv', '{"kind": "display"}');
select tests.create_user('kiosk_u', '{"kind": "kiosk"}');

create table tests.s (name text, id uuid default gen_random_uuid());
insert into tests.s (name) values ('absolute'), ('idle'), ('active'), ('fresh'), ('stale_new'), ('tv'), ('kiosk_u');
insert into auth.sessions (id, user_id, created_at)
select id, tests.id(case name when 'kiosk_u' then 'kiosk_u' else name end),
       case name when 'absolute' then now() - interval '12 hours 1 minute'
                 when 'idle' then now() - interval '2 hours'
                 when 'active' then now() - interval '11 hours'
                 when 'fresh' then now() - interval '5 minutes'
                 when 'stale_new' then now() - interval '31 minutes'
                 else now() - interval '3 days' end
from tests.s;
insert into auth.refresh_tokens (instance_id, token, user_id, revoked, created_at, updated_at, session_id)
select '00000000-0000-0000-0000-000000000000', 'rt-' || name, tests.id(name)::text, false, now(), now(), id
from tests.s where name = 'absolute';
create function tests.sid(p_name text) returns uuid language sql as $$ select id from tests.s where name = p_name $$;
create function tests.alive(p_name text) returns boolean language sql as $$
  select exists (select 1 from auth.sessions where id = tests.sid(p_name)) $$;

-- Activity is recorded for the caller's own session.
select tests.as_user(tests.id('idle'), jsonb_build_object('session_id', tests.sid('idle')));
select lives_ok($$ select api.touch_session() $$, 'a signed-in person records activity');
select tests.as_postgres();
update private.session_activity set last_seen_at = now() - interval '31 minutes' where session_id = tests.sid('idle');

select tests.as_user(tests.id('active'), jsonb_build_object('session_id', tests.sid('active')));
select lives_ok($$ select api.touch_session() $$, 'activity is recorded for another session');
select lives_ok($$ select api.touch_session() $$, 'recording twice is a no-op, not an error');
select tests.as_postgres();
select is((select count(*) from private.session_activity where session_id = tests.sid('active')), 1::bigint,
  'one activity row per session');

-- A session id that is not yours (or has ended) is not_found: no cross-account touching.
select tests.as_user(tests.id('fresh'), jsonb_build_object('session_id', tests.sid('idle')));
select throws_ok($$ select api.touch_session() $$, 'P0001', 'not_found',
  'cannot keep someone else''s session alive');
select tests.as_user(tests.id('fresh'), jsonb_build_object('session_id', gen_random_uuid()));
select throws_ok($$ select api.touch_session() $$, 'P0001', 'not_found', 'an ended session is not_found');
select tests.as_user(tests.id('fresh'));
select throws_ok($$ select api.touch_session() $$, 'P0001', 'not_found', 'a token with no session is not_found');
select tests.as_anon();
select throws_ok($$ select api.touch_session() $$, '42501', null, 'anon cannot call it');
select tests.as_postgres();

select tests.as_postgres();
select is(ops.end_expired_sessions(), 3, 'ends the absolute, idle and never-active-for-31-minutes sessions');
select ok(not tests.alive('absolute'), '12 hours after sign-in the session ends even when the person was active');
select is((select count(*) from auth.refresh_tokens where token = 'rt-absolute'), 0::bigint,
  'its refresh token goes with it, so the token cannot be refreshed');
select ok(not tests.alive('idle'), '31 minutes without activity ends the session');
select ok(not tests.alive('stale_new'), 'a session that never reported activity idles from sign-in');
select ok(tests.alive('active'), 'recent activity keeps a session (even 11 hours old)');
select ok(tests.alive('fresh'), 'a new session is untouched');
select ok(tests.alive('tv') and tests.alive('kiosk_u'), 'paired displays and kiosks are exempt');
select is(ops.end_expired_sessions(), 0, 'running again changes nothing');

select * from finish();
rollback;
