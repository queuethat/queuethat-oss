-- #85: owners see and choose the join address (the location slug) before it is printed.
-- Interface rule 7, alternatives: (1) append a defaulted p_slug to api.create_organization, as
-- api.create_location already has, plus a read-only suggestion call so the wizard can show the
-- address live; (2) keep server-chosen slugs and only improve the generator. (1) won: the owner
-- sees and controls what goes on the poster (I-10), and (2)'s better default is part of (1) anyway.
-- New entry point api.suggest_location_slug (rule 1): no existing call answers "which address
-- would this location get"; it is read-only and for signed-in users only.
-- redefines api.create_organization from 20261025005200_create_org_slug_retry.sql

create function private.suggest_slug(p_location_name text, p_business_name text, p_wanted text)
returns text
language plpgsql volatile set search_path = '' as $$
declare
  candidate text;
begin
  -- The plain location name, then business plus location, before any random suffix.
  foreach candidate in array array[
    private.slugify(coalesce(nullif(btrim(p_wanted), ''), p_location_name)),
    private.slugify(p_location_name),
    private.slugify(coalesce(p_business_name, '') || ' ' || coalesce(p_location_name, ''))
  ] loop
    if not exists (select 1 from app.locations where slug = candidate)
       and not exists (select 1 from app.slug_redirects where old_slug = candidate) then
      return candidate;
    end if;
  end loop;
  return private.unique_location_slug(p_location_name);
end $$;
comment on function private.suggest_slug(text, text, text) is
  'The first free slug of: p_wanted (slugified), the location name, the business and location '
  'name together; else the location name with a random suffix. A slug in slug_redirects counts as '
  'taken. Free means free right now: a concurrent insert can still take it.';

create function api.suggest_location_slug(
  p_location_name text, p_business_name text default null, p_wanted text default null)
returns text
language plpgsql volatile security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  return private.suggest_slug(left(p_location_name, 120), left(p_business_name, 120),
                              left(p_wanted, 64));
end $$;
comment on function api.suggest_location_slug(text, text, text) is
  'The join address (slug) a new location would get: p_wanted when it is free (slugified), else '
  'the location name, else business plus location name, else the name with a random suffix. '
  'Read-only; the address is only reserved when the location is created. Signed-in users only; '
  'raises not_authenticated (42501).';
revoke all on function api.suggest_location_slug(text, text, text) from public, anon;
grant execute on function api.suggest_location_slug(text, text, text) to authenticated;

-- The appended p_slug makes a new signature, so the old one goes in the same step; named-argument
-- callers (supabase-js) are unaffected.
drop function api.create_organization(text, text, text);

create function api.create_organization(p_name text, p_location_name text, p_tz text,
                                        p_slug text default null)
returns api.org_bootstrap
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  result api.org_bootstrap;
  attempt int := 0;
  lost_to text;
  v_slug text := nullif(btrim(coalesce(p_slug, '')), '');
begin
  if uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- Paired displays and kiosks are auth users too; they must never become owners of anything.
  if exists (select 1 from app.devices d where d.auth_user_id = uid)
     or coalesce((select auth.jwt()) -> 'app_metadata' ->> 'kind', '') in ('display', 'kiosk') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_tz is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz) then
    raise exception 'invalid_timezone';
  end if;
  if length(btrim(coalesce(p_name, ''))) = 0 or length(btrim(coalesce(p_location_name, ''))) = 0 then
    raise exception 'invalid_input';
  end if;
  -- #85: an address the owner chose is taken as is or refused, never silently changed.
  if v_slug is not null then
    if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_slug) > 64 then
      raise exception 'invalid_input';
    end if;
    if exists (select 1 from app.locations where slug = v_slug)
       or exists (select 1 from app.slug_redirects where old_slug = v_slug) then
      raise exception 'slug_taken';
    end if;
  end if;

  insert into app.organizations (name, created_by) values (btrim(p_name), uid)
  returning id into result.org_id;

  -- The slug check only sees committed rows, so a concurrent signup can take the same slug first.
  -- A chosen slug then fails with slug_taken (the wizard asks again); a derived one is derived
  -- again, and each later candidate is free or random, so a few attempts suffice.
  loop
    begin
      insert into app.locations (org_id, name, slug, tz)
      values (result.org_id, btrim(p_location_name),
              coalesce(v_slug, private.suggest_slug(p_location_name, p_name, null)), p_tz)
      returning id into result.location_id;
      exit;
    exception when unique_violation then
      get stacked diagnostics lost_to = constraint_name;
      attempt := attempt + 1;
      if lost_to <> 'locations_slug_key' then
        raise;
      end if;
      if v_slug is not null then
        raise exception 'slug_taken';
      end if;
      if attempt >= 5 then
        raise;
      end if;
    end;
  end loop;

  insert into app.memberships (org_id, user_id, role) values (result.org_id, uid, 'owner');

  return result;
end $$;
comment on function api.create_organization(text, text, text, text) is
  'Creates an organization, its first location and the caller''s owner membership in one '
  'transaction, and returns their ids. The location slug is p_slug when given (lowercase letters, '
  'digits and single hyphens, at most 64), else derived as api.suggest_location_slug would and made '
  'unique, even when concurrent calls use the same name. Raises not_authenticated (42501) without '
  'a session, permission_denied (42501) for a paired display or kiosk, invalid_timezone when p_tz '
  'is not an IANA zone name, invalid_input for blank names or a malformed slug, slug_taken when '
  'p_slug is in use.';
revoke all on function api.create_organization(text, text, text, text) from public, anon;
grant execute on function api.create_organization(text, text, text, text) to authenticated;

notify pgrst, 'reload schema';
