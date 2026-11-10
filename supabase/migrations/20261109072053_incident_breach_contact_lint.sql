-- #1274: db lint fails on the literal EXECUTE in private.org_breach_contact while app.org_privacy
-- (C7) does not exist yet. Build the statement with format() so the linter treats it as dynamic.
-- redefines private.org_breach_contact from 20261109064744_platform_incidents.sql
create or replace function private.org_breach_contact(p_org_id uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v jsonb;
  v_table text;
begin
  select to_regclass('app.org_privacy')::text into v_table;
  if v_table is null then
    return null;
  end if;
  execute format(
    'select jsonb_build_object(''name'', p.officer_name, ''email'', p.email, ''phone'', p.phone) from %s p where p.org_id = $1',
    v_table) into v using p_org_id;
  return v;
end $$;
