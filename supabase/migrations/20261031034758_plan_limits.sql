-- 4-BILL3 (#379): free plan limits, enforced in the database through the entitlement resolver.
-- Limits are plan defaults for the keys below (an operator override still wins) and cap only the
-- creation of locations and staff seats, and the switching on of paid channels. Visits are never
-- metered and nothing guest-facing reads these keys, so a limit can never block a guest. A downgrade
-- keeps every existing location, member and visit; only new ones are refused.
-- While billing is off no plan applies, so the global defaults (unlimited, paid channels allowed) hold.

insert into app.entitlement_defaults (key, value, description) values
  ('limit.locations', '-1', 'Locations an org may have; -1 is unlimited'),
  ('limit.members', '-1', 'Staff seats (memberships) an org may have; -1 is unlimited'),
  ('paid_channels', 'true', 'Whether the org may switch on SMS and WhatsApp');
insert into app.plan_entitlements (plan_id, key, value) values
  ('free', 'limit.locations', '1'),
  ('free', 'limit.members', '3'),
  ('free', 'paid_channels', 'false');

create function private.enforce_plan_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_limit int := nullif(private.entitlement(new.org_id, tg_argv[0]) #>> '{}', '')::int;
  v_count int;
begin
  if v_limit is null or v_limit < 0 then return new; end if;
  -- two concurrent inserts for one org must not both pass the check
  perform pg_advisory_xact_lock(hashtextextended('plan_limit:' || new.org_id || tg_argv[0], 0));
  execute format('select count(*) from %I.%I where org_id = $1', tg_table_schema, tg_table_name)
    into v_count using new.org_id;
  if v_count >= v_limit then raise exception 'plan_limit_reached'; end if;
  return new;
end $$;
comment on function private.enforce_plan_limit() is
  'BEFORE INSERT guard (argument: the entitlement key holding the limit): refuses the row with '
  'plan_limit_reached when the org already has that many. A limit of -1 or an unknown key is unlimited.';
revoke all on function private.enforce_plan_limit() from public, anon, authenticated;

create trigger plan_limit before insert on app.locations
  for each row execute function private.enforce_plan_limit('limit.locations');
create trigger plan_limit before insert on app.memberships
  for each row execute function private.enforce_plan_limit('limit.members');

-- redefines private.channel_missing from 20261031033858_pos_crm_channels.sql
-- The only change: sms and whatsapp also need a plan that allows paid channels.
create or replace function private.channel_missing(p_org_id uuid, p_channel text) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  f app.platform_flags;
  s app.provider_settings;
  l app.channel_limits;
  missing text[] := '{}';
begin
  select * into f from app.platform_flags;
  select * into s from app.provider_settings where org_id = p_org_id and channel = p_channel;
  if p_channel in ('sms', 'whatsapp') and not private.entitled(p_org_id, 'paid_channels') then
    missing := array_append(missing, 'plan_allows_paid_channels');
  end if;
  -- the SMS compliance gate and the provider test event do not apply to an LLM key
  if p_channel not in ('llm', 'pos', 'crm') and f.compliance_gate_passed_at is null then missing := array_append(missing, 'compliance_gate'); end if;
  if not found then
    return array_append(missing, 'provider_settings');
  end if;
  if s.mode = 'platform' and f.hosted_legal_reviewed_at is null then missing := array_append(missing, 'hosted_legal_review'); end if;
  if s.verified_at is null and p_channel <> 'llm' then missing := array_append(missing, 'provider_verified'); end if;
  if p_channel = 'sms' then
    select * into l from app.channel_limits where org_id = p_org_id and channel = 'sms';
    -- no row means the defaults: a cap of 200 and no allowed country
    if coalesce(l.daily_cap, 200) <= 0 then missing := array_append(missing, 'daily_cap'); end if;
    if coalesce(cardinality(l.country_allowlist), 0) = 0 then missing := array_append(missing, 'country_allowlist'); end if;
    -- A US campaign is needed unless the sender is known to be outside +1 and no allowed country shares +1
    -- (the allowlist is matched against the number's calling code, so CA admits US numbers too).
    if (exists (select 1 from app.dial_codes d where d.prefix = '1' and d.country_code = any (coalesce(l.country_allowlist, '{}')))
        or regexp_replace(coalesce(s.config ->> 'from_number', ''), '\s', '', 'g') !~ '^\+'
        or regexp_replace(coalesce(s.config ->> 'from_number', ''), '\s', '', 'g') like '+1%')
       and coalesce(s.messaging_campaign_ref, '') = '' then
      missing := array_append(missing, 'campaign_ref');
    end if;
  end if;
  return missing;
end $$;
revoke all on function private.channel_missing(uuid, text) from public, anon, authenticated;
