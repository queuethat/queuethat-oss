-- Operator/staff session limits: signed out 12 hours after signing in, or after 30 minutes
-- without activity. Applies to every signed-in person (owner, staff, platform operator); paired
-- displays and kiosks (app_metadata.kind) are unattended and exempt. Guests never have a session.
--
-- Why not GoTrue's own [auth.sessions] timebox / inactivity_timeout: they are project-wide, so
-- they would sign out every paired TV, and "inactivity" there means no token refresh, which an
-- open idle tab keeps doing, so it never fires. Activity has to come from the person.
--
-- The web app calls api.touch_session() at most once a minute while the person is using the
-- app. A cron job deletes expired auth.sessions (their refresh tokens cascade), so the next token
-- refresh fails and the app signs out. A stolen access token still works until it expires, so
-- config.toml shortens jwt_expiry to 5 minutes.

create table private.session_activity (
  session_id uuid primary key references auth.sessions (id) on delete cascade,
  last_seen_at timestamptz not null default now()
);
alter table private.session_activity enable row level security;
comment on table private.session_activity is
  'When each signed-in session last reported activity. Written only by api.touch_session.';

create function api.touch_session() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_session uuid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
begin
  -- The session must exist and be the caller's own: nobody can keep another account signed in.
  if v_session is null or not exists (
    select 1 from auth.sessions where id = v_session and user_id = (select auth.uid())
  ) then
    raise exception 'not_found';
  end if;
  insert into private.session_activity as a (session_id, last_seen_at) values (v_session, now())
  on conflict (session_id) do update set last_seen_at = now();
exception when foreign_key_violation then
  -- The cron job ended the session between the check and the insert.
  raise exception 'not_found';
end $$;
comment on function api.touch_session() is
  'Records that the signed-in person is using the app, which keeps their session past the 30 '
  'minute idle limit. Repeating it changes nothing but the time. Raises not_found when the '
  'caller has no live session of their own, which is how the app learns it has been signed out.';
revoke all on function api.touch_session() from public, anon, authenticated, service_role;
grant execute on function api.touch_session() to authenticated;

create function ops.end_expired_sessions() returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ended integer;
begin
  with ended as (
    delete from auth.sessions s
    using auth.users u
    where u.id = s.user_id
      and coalesce(u.raw_app_meta_data ->> 'kind', '') not in ('display', 'kiosk')
      and (s.created_at < now() - interval '12 hours'
           or coalesce((select a.last_seen_at from private.session_activity a where a.session_id = s.id),
                       s.created_at) < now() - interval '30 minutes')
    returning s.id
  )
  select count(*) into v_ended from ended;
  return v_ended;
end $$;
comment on function ops.end_expired_sessions() is
  'Cron: deletes sessions older than 12 hours or idle for 30 minutes, with their refresh tokens. '
  'Paired displays and kiosks are exempt. Returns how many it ended; running it again ends none.';
revoke all on function ops.end_expired_sessions() from public, anon, authenticated, service_role;
select cron.schedule('end-expired-sessions', '* * * * *', 'select ops.end_expired_sessions()');

notify pgrst, 'reload schema';
