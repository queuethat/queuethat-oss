-- 2P-BRD1 (#202): branding assets and fields, read publicly through one anon RPC.
--   * Storage bucket `branding`: public (so logos load without a signed URL), 2 MB, png/jpeg/webp only
--     (no SVG: it carries script). Paths are org/{org_id}/branding/{file}. Admins of that org write;
--     nobody lists anonymously (a public bucket serves known object URLs without any select policy).
--   * organizations.logo_path already exists; brand colours join it. locations gain cover, welcome text
--     and legal links. Paths must sit under the row's own org prefix, URLs must be https.

alter table app.organizations
  add column brand_primary text check (brand_primary ~ '^#[0-9a-fA-F]{6}$'),
  add column brand_accent text check (brand_accent ~ '^#[0-9a-fA-F]{6}$'),
  add constraint organizations_logo_path_check
    check (logo_path is null or logo_path ~ ('^org/' || id::text || '/branding/[A-Za-z0-9_-][A-Za-z0-9._-]*$'));
grant update (brand_primary, brand_accent) on app.organizations to authenticated, service_role;

alter table app.locations
  add column cover_path text,
  add column welcome_text text check (length(welcome_text) <= 500),
  add column terms_url text check (terms_url ~ '^https://[^[:space:]]+$' and length(terms_url) <= 2048),
  add column privacy_url text check (privacy_url ~ '^https://[^[:space:]]+$' and length(privacy_url) <= 2048),
  add constraint locations_cover_path_check
    check (cover_path is null or cover_path ~ ('^org/' || org_id::text || '/branding/[A-Za-z0-9_-][A-Za-z0-9._-]*$'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('branding', 'branding', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

/** The org id in an object path org/{uuid}/branding/{file}, or null when the path has another shape. */
create function private.branding_path_org(p_name text) returns uuid
language sql immutable set search_path = '' as $$
  select case when p_name ~ '^org/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/branding/[A-Za-z0-9_-][A-Za-z0-9._-]*$'
              then split_part(p_name, '/', 2)::uuid end
$$;
comment on function private.branding_path_org(text) is
  'The org id of a branding object path (org/{org_id}/branding/{file}), or null for any other path.';
revoke all on function private.branding_path_org(text) from public;
grant execute on function private.branding_path_org(text) to authenticated;

create policy branding_select on storage.objects for select to authenticated
  using (bucket_id = 'branding' and (select private.has_role(private.branding_path_org(name), null, 'admin')));
create policy branding_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'branding' and (select private.has_role(private.branding_path_org(name), null, 'admin')));
create policy branding_update on storage.objects for update to authenticated
  using (bucket_id = 'branding' and (select private.has_role(private.branding_path_org(name), null, 'admin')))
  with check (bucket_id = 'branding' and (select private.has_role(private.branding_path_org(name), null, 'admin')));
create policy branding_delete on storage.objects for delete to authenticated
  using (bucket_id = 'branding' and (select private.has_role(private.branding_path_org(name), null, 'admin')));

create type api.location_branding as (
  org_name text, logo_url text, cover_url text, brand_primary text, brand_accent text,
  welcome_text text, terms_url text, privacy_url text
);
grant usage on type api.location_branding to anon, authenticated, service_role;

create function api.get_location_branding(p_slug text) returns api.location_branding
language plpgsql stable security definer set search_path = '' as $$
declare
  l app.locations;
  o app.organizations;
begin
  select * into l from app.locations where slug = p_slug;
  if not found then
    select loc.* into l
    from app.slug_redirects r join app.locations loc on loc.id = r.location_id
    where r.old_slug = p_slug;
  end if;
  if l.id is null then
    raise exception 'not_found';
  end if;
  select * into o from app.organizations where id = l.org_id;
  return row(
    o.name,
    case when o.logo_path is not null then '/storage/v1/object/public/branding/' || o.logo_path end,
    case when l.cover_path is not null then '/storage/v1/object/public/branding/' || l.cover_path end,
    o.brand_primary, o.brand_accent, l.welcome_text, l.terms_url, l.privacy_url
  )::api.location_branding;
end $$;
comment on function api.get_location_branding(text) is
  'Public branding of the location (by slug or a retired slug): organization name, logo and cover '
  'as paths under the API origin (/storage/v1/object/public/branding/...), brand colours as #rrggbb, '
  'plain-text welcome text and https terms and privacy links. Anon-callable and read-only; nothing '
  'else about the org or location is returned. Raises not_found for an unknown slug.';
revoke all on function api.get_location_branding(text) from public;
grant execute on function api.get_location_branding(text) to anon, authenticated;
