-- #93 (2A-ORG5): the onboarding wizard lists templates before the new owner has an organization,
-- so any signed-in user may list them (the data is static and public in the repo).
-- redefines api.list_industry_templates from 20261030071733_industry_templates.sql
create or replace function api.list_industry_templates()
returns setof api.industry_template
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  return query
    select t.key, t.value ->> 'name', t.value ->> 'description', (t.value ->> 'health_tagged')::boolean
    from jsonb_each(private.industry_templates()) t(key, value)
    order by t.key;
end $$;
comment on function api.list_industry_templates() is
  'The setup templates (barber, clinic, restaurant and so on) a new location can start from. Any '
  'signed-in user, including one who has not created an organization yet. Raises '
  'permission_denied (42501) for anon. Implemented by 2A-ORG4.';
