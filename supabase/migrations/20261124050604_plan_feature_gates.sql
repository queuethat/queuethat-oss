-- Plan gates for the ee features and a per-location queue cap.
-- A deployment that sells plans (a hosted service) supplies the values through private.ext_entitlement.
-- Every default below is permissive, so a self-hosted install is unchanged. Only creating new rows is
-- refused; rows that exist stay, stay readable and keep working, so a downgrade never deletes data.

insert into app.entitlement_defaults (key, value, description) values
  ('feature.integrations', 'true', 'Whether the org may add a CRM, POS or other integration'),
  ('feature.api', 'true', 'Whether the org may create API keys and webhook endpoints'),
  ('feature.custom_roles', 'true', 'Whether the org may create custom roles and staff shifts'),
  ('feature.reports_pro', 'true', 'Whether the org may schedule reports and connect an ask-your-data LLM key'),
  ('limit.queues', '-1', 'Active queues an org may have at one location; -1 is unlimited');

create function private.enforce_feature() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Optional further arguments name the channels the guard applies to (provider_settings holds
  -- channels that are not gated); a row of any other channel passes.
  if tg_nargs > 1 and not ((to_jsonb(new) ->> 'channel') = any (tg_argv[1:])) then return new; end if;
  if not private.entitled(new.org_id, tg_argv[0]) then
    raise exception 'feature_not_in_plan' using detail = tg_argv[0];
  end if;
  return new;
end $$;
comment on function private.enforce_feature() is
  'BEFORE INSERT guard (first argument: the entitlement key; further arguments: the channels it applies to, '
  'when the table holds channels that are not gated): refuses the row with feature_not_in_plan, detail = '
  'the key, unless the org is entitled. Existing rows are never touched.';
revoke all on function private.enforce_feature() from public, anon, authenticated;

create trigger plan_feature before insert on app.api_keys
  for each row execute function private.enforce_feature('feature.api');
create trigger plan_feature before insert on app.webhook_endpoints
  for each row execute function private.enforce_feature('feature.api');
create trigger plan_feature before insert on app.custom_roles
  for each row execute function private.enforce_feature('feature.custom_roles');
create trigger plan_feature before insert on app.staff_shifts
  for each row execute function private.enforce_feature('feature.custom_roles');
create trigger plan_feature before insert on app.report_schedules
  for each row execute function private.enforce_feature('feature.reports_pro');
create trigger plan_feature_integrations before insert on app.provider_settings
  for each row execute function private.enforce_feature('feature.integrations', 'pos', 'crm');
create trigger plan_feature_llm before insert on app.provider_settings
  for each row execute function private.enforce_feature('feature.reports_pro', 'llm');

create function private.enforce_queue_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_limit int := nullif(private.entitlement(new.org_id, 'limit.queues') #>> '{}', '')::int;
  v_count int;
begin
  if v_limit is null or v_limit < 0 or new.archived_at is not null then return new; end if;
  -- two concurrent inserts for one location must not both pass the check
  perform pg_advisory_xact_lock(hashtextextended('queue_limit:' || new.location_id, 0));
  select count(*) into v_count from app.queues
   where org_id = new.org_id and location_id = new.location_id and archived_at is null;
  if v_count >= v_limit then raise exception 'plan_limit_reached' using detail = v_limit::text; end if;
  return new;
end $$;
comment on function private.enforce_queue_limit() is
  'BEFORE INSERT guard: refuses a new active queue with plan_limit_reached (detail = the limit) when the '
  'location already has that many. -1 is unlimited. Archiving a queue frees its place.';
revoke all on function private.enforce_queue_limit() from public, anon, authenticated;

create trigger plan_limit before insert on app.queues
  for each row execute function private.enforce_queue_limit();
