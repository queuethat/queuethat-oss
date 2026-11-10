-- 4-SIG1 (#389): digital signage slides (D-8), shown on the TV display between calls.
--   * app.signage_slides: image or text slides per location with a duration, an optional schedule
--     window and a sort position. Admins of the location write; staff and devices of the org read.
--   * Storage bucket `signage`: public (the TV loads known URLs without a token), 5 MB, png/jpeg/webp
--     only (no SVG: it carries script). Same path rules as the branding bucket, under org/{org}/signage/.
--   * api.display_signage(location): the slides active now, in order, with nothing but what the TV
--     renders. Callable by staff and paired devices of that location; anyone else gets not_found.

create type app.signage_kind as enum ('image', 'text');

create table app.signage_slides (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  kind app.signage_kind not null,
  storage_path text,
  body text check (length(btrim(body)) between 1 and 300),
  duration_s int not null default 10 check (duration_s between 3 and 120),
  active_from timestamptz,
  active_to timestamptz,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, location_id) references app.locations (org_id, id) on delete cascade,
  unique (org_id, id),
  check (active_to is null or active_from is null or active_to > active_from),
  -- An image slide is a path under its own org's signage folder; a text slide is text. Never both.
  check ((kind = 'image' and body is null
          and storage_path ~ ('^org/' || org_id::text || '/signage/[A-Za-z0-9_-][A-Za-z0-9._-]*$'))
      or (kind = 'text' and storage_path is null and body is not null))
);
create index signage_slides_location_idx on app.signage_slides (location_id, sort);

create trigger forbid_org_change before update on app.signage_slides
  for each row execute function private.forbid_org_change();
create trigger touch_updated_at before update on app.signage_slides
  for each row execute function private.touch_updated_at();
create trigger audit_row after insert or update or delete on app.signage_slides
  for each row execute function private.audit_row();

alter table app.signage_slides enable row level security;
create policy signage_slides_select on app.signage_slides for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')) or (select private.is_device(org_id, location_id)));
create policy signage_slides_insert on app.signage_slides for insert to authenticated
  with check ((select private.has_role(org_id, location_id, 'admin')));
create policy signage_slides_update on app.signage_slides for update to authenticated
  using ((select private.has_role(org_id, location_id, 'admin')))
  with check ((select private.has_role(org_id, location_id, 'admin')));
create policy signage_slides_delete on app.signage_slides for delete to authenticated
  using ((select private.has_role(org_id, location_id, 'admin')));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('signage', 'signage', true, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

/** The org id in an object path org/{uuid}/signage/{file}, or null when the path has another shape. */
create function private.signage_path_org(p_name text) returns uuid
language sql immutable set search_path = '' as $$
  select case when p_name ~ '^org/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/signage/[A-Za-z0-9_-][A-Za-z0-9._-]*$'
              then split_part(p_name, '/', 2)::uuid end
$$;
comment on function private.signage_path_org(text) is
  'The org id of a signage object path (org/{org_id}/signage/{file}), or null for any other path.';
revoke all on function private.signage_path_org(text) from public;
grant execute on function private.signage_path_org(text) to authenticated;

create policy signage_select on storage.objects for select to authenticated
  using (bucket_id = 'signage' and (select private.has_role(private.signage_path_org(name), null, 'admin')));
create policy signage_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'signage' and (select private.has_role(private.signage_path_org(name), null, 'admin')));
create policy signage_update on storage.objects for update to authenticated
  using (bucket_id = 'signage' and (select private.has_role(private.signage_path_org(name), null, 'admin')))
  with check (bucket_id = 'signage' and (select private.has_role(private.signage_path_org(name), null, 'admin')));
create policy signage_delete on storage.objects for delete to authenticated
  using (bucket_id = 'signage' and (select private.has_role(private.signage_path_org(name), null, 'admin')));

create type api.signage_slide as (kind text, image_url text, body text, duration_s int);
grant usage on type api.signage_slide to authenticated, service_role;

create function api.display_signage(p_location_id uuid) returns setof api.signage_slide
language plpgsql stable security definer set search_path = '' as $$
declare
  l app.locations;
begin
  select * into l from app.locations where id = p_location_id;
  if not found or not (private.has_role(l.org_id, l.id, 'staff') or private.is_device(l.org_id, l.id)) then
    raise exception 'not_found';
  end if;
  return query
  select s.kind::text,
         case when s.storage_path is not null then '/storage/v1/object/public/signage/' || s.storage_path end,
         s.body, s.duration_s
  from app.signage_slides s
  where s.location_id = l.id
    and (s.active_from is null or s.active_from <= now())
    and (s.active_to is null or s.active_to > now())
  order by s.sort, s.created_at, s.id;
end $$;
comment on function api.display_signage(uuid) is
  'The signage slides active now at the location, in display order: kind (image or text), the image as a '
  'path under the API origin (/storage/v1/object/public/signage/...), plain-text body and seconds on screen. '
  'Nothing else about a slide is returned. Callable by staff and paired devices of that location; raises '
  'not_found for anyone else, including a display of another location.';
revoke all on function api.display_signage(uuid) from public, anon;
grant execute on function api.display_signage(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
