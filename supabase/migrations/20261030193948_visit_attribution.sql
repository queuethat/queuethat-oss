-- 2B-J8 (#246): where an online join came from (Google Business Profile link, website widget, poster).
-- A separate column, not new values for visits.source: source is the channel the join rules key on
-- (on-site code, geofence, rate limits, priority rules all test source = 'online'), so a visit
-- that carried its own source value would slip past them. Attribution is a label only.

alter table app.visits
  add column attribution text check (attribution in ('gbp', 'widget', 'poster'));
comment on column app.visits.attribution is
  'Where an online join came from: gbp (Google Business Profile link), widget (embedded join form) or poster (QR code). Null for everything else. Set only from an allowlisted value that public-join forwards; never client text.';

-- The public-join Edge Function forwards the guest's ?src= as x-qm-src. Only the service role is
-- believed, and only three values are kept; anything else leaves the column null.
create function private.stamp_attribution() returns trigger
language plpgsql set search_path = '' as $$
declare
  headers jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}');
  src text;
begin
  if new.source = 'online' and (select auth.role()) = 'service_role' then
    src := headers ->> 'x-qm-src';
    if src in ('gbp', 'widget', 'poster') then
      new.attribution := src;
    end if;
  end if;
  return new;
end $$;
revoke all on function private.stamp_attribution() from public, anon, authenticated;
comment on function private.stamp_attribution() is
  'Before insert on app.visits: copies an allowlisted x-qm-src header (service role only) into attribution for online joins. Not exposed.';
create trigger stamp_attribution before insert on app.visits
  for each row execute function private.stamp_attribution();
