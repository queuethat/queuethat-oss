-- 2P-APT15 (#171): per-staff calendar feeds. Calendar apps fetch the feed with no sign-in, so the URL
-- carries a secret: 32 random bytes, stored only as sha256, revocable. The feed shows each staff member's
-- own appointments across the orgs where their membership is active (removing a member deletes their
-- feeds). It carries no phone or email, and guest first names only when the member opted in.

create table app.calendar_feeds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  user_id uuid not null,
  token_hash bytea not null unique,
  include_guest_names boolean not null default false,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_accessed_at timestamptz,
  foreign key (org_id, user_id) references app.memberships (org_id, user_id) on delete cascade
);
create index calendar_feeds_user_idx on app.calendar_feeds (user_id);
alter table app.calendar_feeds enable row level security;
create policy calendar_feeds_select on app.calendar_feeds for select to authenticated
  using (user_id = (select auth.uid()));
-- Only the RPCs write feeds, and nobody reads the hash back.
revoke insert, update, delete, truncate on app.calendar_feeds from authenticated;
revoke select on app.calendar_feeds from authenticated;
grant select (id, org_id, user_id, include_guest_names, created_at, revoked_at, last_accessed_at)
  on app.calendar_feeds to authenticated;

create type api.calendar_feed_created as (feed_id uuid, token text);
grant usage on type api.calendar_feed_created to authenticated, service_role;

create function api.create_calendar_feed(p_include_guest_names boolean) returns api.calendar_feed_created
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  m app.memberships;
  v_token text;
  result api.calendar_feed_created;
begin
  select * into m from app.memberships where user_id = uid order by created_at limit 1;
  if uid is null or m.user_id is null then raise exception 'not_a_member'; end if;
  if (select count(*) from app.calendar_feeds f where f.user_id = uid and f.revoked_at is null) >= 10 then
    raise exception 'rate_limited';
  end if;
  v_token := translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');
  insert into app.calendar_feeds (org_id, user_id, token_hash, include_guest_names)
  values (m.org_id, uid, extensions.digest(v_token, 'sha256'), coalesce(p_include_guest_names, false))
  returning id into result.feed_id;
  result.token := v_token;
  return result;
end $$;
comment on function api.create_calendar_feed(boolean) is
  'Creates a calendar feed for the signed-in member and returns its 43-character token once; only its '
  'sha256 is stored. The feed lists the member''s own appointments in every org where they are still a '
  'member. p_include_guest_names puts guest first names in event titles. At most 10 live feeds per member '
  '(rate_limited). Raises not_a_member.';
revoke all on function api.create_calendar_feed(boolean) from public, anon;
grant execute on function api.create_calendar_feed(boolean) to authenticated, service_role;

create function api.revoke_calendar_feed(p_feed_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  update app.calendar_feeds set revoked_at = coalesce(revoked_at, now())
  where id = p_feed_id and user_id = (select auth.uid());
  if not found then raise exception 'not_found'; end if;
end $$;
comment on function api.revoke_calendar_feed(uuid) is
  'Revokes one of the caller''s own feeds; the URL stops working at once. Repeating is a no-op. Raises not_found for an unknown or foreign id.';
revoke all on function api.revoke_calendar_feed(uuid) from public, anon;
grant execute on function api.revoke_calendar_feed(uuid) to authenticated, service_role;

-- Called only by the ics-feed Edge Function (service role). Guest names are null unless the feed opted in.
create function api.calendar_feed_events(p_token text) returns setof api.appointment_row
language plpgsql volatile security definer set search_path = '' as $$
declare f app.calendar_feeds;
begin
  select * into f from app.calendar_feeds where token_hash = extensions.digest(coalesce(p_token, ''), 'sha256') and revoked_at is null;
  if f.id is null then raise exception 'not_found'; end if;
  update app.calendar_feeds set last_accessed_at = now()
   where id = f.id and (last_accessed_at is null or last_accessed_at < now() - interval '10 minutes');
  return query
  select a.id, a.location_id, a.service_id, a.staff_user_id, a.starts_at, a.ends_at, a.status::text,
         case when f.include_guest_names then split_part(regexp_replace(a.guest_name, '[[:cntrl:]]', ' ', 'g'), ' ', 1) end, a.visit_id, a.version
  from app.appointments a
  join app.memberships m on m.org_id = a.org_id and m.user_id = f.user_id
  where a.staff_user_id = f.user_id
    and a.status in ('booked', 'checked_in', 'completed')
    and a.starts_at >= now() - interval '7 days' and a.starts_at < now() + interval '60 days'
  order by a.starts_at;
end $$;
comment on function api.calendar_feed_events(text) is
  'The feed''s appointments from 7 days back to 60 days ahead, for orgs where the owner is still a member. '
  'Service role only. No contact data; guest first name only when the feed opted in. Raises not_found for '
  'an unknown or revoked token.';
revoke all on function api.calendar_feed_events(text) from public, anon, authenticated;
grant execute on function api.calendar_feed_events(text) to service_role;
