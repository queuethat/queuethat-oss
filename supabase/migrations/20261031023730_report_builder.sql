-- 4-RPT1 (#392): saved report definitions and api.run_report over a fixed metric catalogue.
-- A definition is JSON naming whitelisted measures, dimensions and filters. Nothing the caller sends is
-- ever spliced into SQL: keys are matched against the catalogue below, which maps each name to a
-- constant SQL fragment, and filter values travel as bind parameters. Guest names and contacts have no
-- catalogue entry, so they can never be a dimension. Replaces the stub from 20261031021600_api_contracts_4.sql.

-- Raises invalid_report_definition unless p_def is an object with only known keys, 1..6 distinct
-- catalogue measures, at most 3 distinct catalogue dimensions and well-formed filters.
create function private.report_validate(p_def jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare
  k text;
  v jsonb;
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if p_def is null or jsonb_typeof(p_def) <> 'object' or pg_column_size(p_def) > 4096 then
    raise exception 'invalid_report_definition';
  end if;
  if exists (select 1 from jsonb_object_keys(p_def) o(key) where o.key not in ('org_id', 'measures', 'dimensions', 'filters')) then
    raise exception 'invalid_report_definition';
  end if;
  if p_def ? 'org_id' and (jsonb_typeof(p_def -> 'org_id') <> 'string' or (p_def ->> 'org_id') !~ c_uuid) then
    raise exception 'invalid_report_definition';
  end if;

  v := p_def -> 'measures';
  if v is null or jsonb_typeof(v) <> 'array' or jsonb_array_length(v) not between 1 and 6
     or exists (select 1 from jsonb_array_elements(v) e(x)
                where jsonb_typeof(e.x) <> 'string'
                   or (e.x #>> '{}') not in ('visits', 'served', 'avg_wait_min', 'avg_service_min', 'no_show_pct', 'eta_error_min'))
     or (select count(distinct e.x) from jsonb_array_elements(v) e(x)) <> jsonb_array_length(v) then
    raise exception 'invalid_report_definition';
  end if;

  v := coalesce(p_def -> 'dimensions', '[]'::jsonb);
  if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 3
     or exists (select 1 from jsonb_array_elements(v) e(x)
                where jsonb_typeof(e.x) <> 'string'
                   or (e.x #>> '{}') not in ('service_day', 'hour', 'weekday', 'service', 'queue', 'location', 'counter'))
     or (select count(distinct e.x) from jsonb_array_elements(v) e(x)) <> jsonb_array_length(v) then
    raise exception 'invalid_report_definition';
  end if;

  v := coalesce(p_def -> 'filters', '{}'::jsonb);
  if jsonb_typeof(v) <> 'object' then
    raise exception 'invalid_report_definition';
  end if;
  for k in select o.key from jsonb_object_keys(v) o(key) loop
    if k in ('location_id', 'queue_id', 'service_id', 'counter_id') then
      if jsonb_typeof(v -> k) <> 'string' or (v ->> k) !~ c_uuid then
        raise exception 'invalid_report_definition';
      end if;
    elsif k = 'source' then
      if jsonb_typeof(v -> k) <> 'string' or (v ->> k) not in ('online', 'staff', 'kiosk', 'appointment', 'api', 'sms') then
        raise exception 'invalid_report_definition';
      end if;
    else
      raise exception 'invalid_report_definition';
    end if;
  end loop;
end $$;
comment on function private.report_validate(jsonb) is
  'The one validator for report definitions (saved and run). Shape and catalogue only; no access checks.';
revoke all on function private.report_validate(jsonb) from public, anon, authenticated;

create table app.report_definitions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  definition jsonb not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index report_definitions_org_idx on app.report_definitions (org_id);
comment on table app.report_definitions is
  'Saved custom reports: a definition over the fixed metric catalogue, never SQL. Managers and above of the org. The org is the column; a stored org_id inside the definition must match it.';

create function private.validate_report_definition() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- The author is the caller and never changes, so audit attribution can't be forged.
  new.created_by := case when tg_op = 'INSERT' then (select auth.uid()) else old.created_by end;
  perform private.report_validate(new.definition);
  if new.definition ? 'org_id' and (new.definition ->> 'org_id')::uuid <> new.org_id then
    raise exception 'invalid_report_definition';
  end if;
  return new;
end $$;
create trigger validate_report_definition before insert or update on app.report_definitions
  for each row execute function private.validate_report_definition();
create trigger forbid_org_change before update on app.report_definitions
  for each row execute function private.forbid_org_change();
create trigger touch_updated_at before update on app.report_definitions
  for each row execute function private.touch_updated_at();
create trigger audit_row after insert or update or delete on app.report_definitions
  for each row execute function private.audit_row();

alter table app.report_definitions enable row level security;
create policy report_definitions_select on app.report_definitions for select to authenticated
  using ((select private.has_role(org_id, null, 'manager')));
create policy report_definitions_insert on app.report_definitions for insert to authenticated
  with check ((select private.has_role(org_id, null, 'manager')));
create policy report_definitions_update on app.report_definitions for update to authenticated
  using ((select private.has_role(org_id, null, 'manager')))
  with check ((select private.has_role(org_id, null, 'manager')));
create policy report_definitions_delete on app.report_definitions for delete to authenticated
  using ((select private.has_role(org_id, null, 'manager')));
grant select, insert, update, delete on app.report_definitions to authenticated;
grant all on app.report_definitions to service_role;

-- redefines api.run_report from 20261031021600_api_contracts_4.sql
create or replace function api.run_report(p_definition jsonb, p_from date, p_to date) returns setof api.report_cell
language plpgsql stable security definer set search_path = '' set statement_timeout = '5s' as $$
declare
  v_org uuid;
  v_filters jsonb;
  v_locs uuid[];
  v_dims text[];
  v_meas text[];
  v_sel text := '';
  v_grp text := '';
  v_dim_obj text := '';
  v_meas_obj text := '';
  v_sql text;
  d text;
  m text;
  i int := 0;
  n int := 0;
  r api.report_cell;
begin
  perform private.report_validate(p_definition);
  if not p_definition ? 'org_id' then
    raise exception 'invalid_report_definition';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from >= 400 then
    raise exception 'range_too_large';
  end if;
  v_org := (p_definition ->> 'org_id')::uuid;
  v_filters := coalesce(p_definition -> 'filters', '{}'::jsonb);
  if not (select private.has_role(v_org, null, 'staff')) then
    raise exception 'not_found';
  end if;
  if not (select private.has_role(v_org, null, 'manager')) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  -- A location-restricted manager only ever aggregates the locations their membership covers.
  select coalesce(array_agg(l.id), '{}') into v_locs from app.locations l
  where l.org_id = v_org and private.has_role(v_org, l.id, 'manager');
  if v_filters ? 'location_id' and not (v_filters ->> 'location_id')::uuid = any (v_locs) then
    raise exception 'not_found';
  end if;

  select array_agg(x #>> '{}') into v_dims from jsonb_array_elements(coalesce(p_definition -> 'dimensions', '[]'::jsonb)) e(x);
  select array_agg(x #>> '{}') into v_meas from jsonb_array_elements(p_definition -> 'measures') e(x);

  -- Every fragment below is a constant chosen by an exact catalogue match; no caller text reaches the SQL.
  foreach d in array coalesce(v_dims, '{}') loop
    i := i + 1;
    v_sel := v_sel || case d
      when 'service_day' then 'v.service_day::text'
      when 'hour' then $q$to_char(v.joined_at at time zone l.tz, 'HH24')$q$
      when 'weekday' then 'extract(isodow from v.service_day)::int'
      when 'service' then $q$coalesce(s.name, '')$q$
      when 'queue' then 'q.name'
      when 'location' then 'l.name'
      when 'counter' then $q$coalesce(c.label, '')$q$
    end || format(' as d%s, ', i);
    v_grp := v_grp || format('%s%s', case when v_grp = '' then 'group by ' else ', ' end, format('d%s', i));
    v_dim_obj := v_dim_obj || format('%s%L, to_jsonb(t.d%s)', case when v_dim_obj = '' then '' else ', ' end, d, i);
  end loop;
  i := 0;
  foreach m in array v_meas loop
    i := i + 1;
    v_sel := v_sel || case m
      when 'visits' then 'count(*)'
      when 'served' then $q$count(*) filter (where v.status = 'served')$q$
      when 'avg_wait_min' then 'round(avg(extract(epoch from v.called_at - v.joined_at) / 60)::numeric, 1)'
      when 'avg_service_min' then 'round(avg(extract(epoch from v.finished_at - v.serving_at) / 60)::numeric, 1)'
      when 'no_show_pct' then $q$round(100.0 * count(*) filter (where v.status = 'no_show') / nullif(count(*), 0), 1)$q$
      when 'eta_error_min' then 'round(avg(greatest(v.eta_quoted_low - extract(epoch from v.called_at - v.joined_at) / 60, extract(epoch from v.called_at - v.joined_at) / 60 - v.eta_quoted_high, 0)) filter (where v.called_at is not null and v.eta_quoted_low is not null)::numeric, 1)'
    end || format(' as m%s%s', i, case when i < cardinality(v_meas) then ', ' else '' end);
    v_meas_obj := v_meas_obj || format('%s%L, to_jsonb(t.m%s)', case when v_meas_obj = '' then '' else ', ' end, m, i);
  end loop;

  v_sql := format($q$
    select jsonb_build_object(%s), jsonb_build_object(%s)
    from (
      select %s
      from app.visits v
      join app.locations l on l.id = v.location_id
      join app.queues q on q.id = v.queue_id
      left join app.services s on s.id = v.service_id
      left join app.counters c on c.id = v.counter_id
      where v.org_id = $1 and v.location_id = any ($2) and v.service_day between $3 and $4
        and ($5::uuid is null or v.location_id = $5) and ($6::uuid is null or v.queue_id = $6)
        and ($7::uuid is null or v.service_id = $7) and ($8::uuid is null or v.counter_id = $8)
        and ($9::text is null or v.source = $9)
      %s
    ) t
    order by %s
  $q$, v_dim_obj, v_meas_obj, v_sel, v_grp,
       coalesce((select string_agg(format('t.d%s', g), ', ') from generate_series(1, cardinality(v_dims)) g), '1'));

  for r in execute v_sql using v_org, v_locs, p_from, p_to,
    (v_filters ->> 'location_id')::uuid, (v_filters ->> 'queue_id')::uuid,
    (v_filters ->> 'service_id')::uuid, (v_filters ->> 'counter_id')::uuid, v_filters ->> 'source'
  loop
    n := n + 1;
    if n > 10000 then
      raise exception 'range_too_large';
    end if;
    return next r;
  end loop;
end $$;
comment on function api.run_report(jsonb, date, date) is
  'Runs a report definition over service days p_from..p_to (inclusive, at most 400 days). The definition is JSON '
  '{org_id, measures (1-6 of visits, served, avg_wait_min, avg_service_min, no_show_pct, eta_error_min), '
  'dimensions (0-3 of service_day, hour, weekday, service, queue, location, counter), filters (location_id, '
  'queue_id, service_id, counter_id, source)}; hour is the location-local join hour, weekday is ISO (1 = Monday). '
  'One row per dimension combination as (dims, measures); none of the numbers identify a guest, and guest names or '
  'contacts are not in the catalogue. Managers and above of the org, over the locations their membership covers; '
  'other members get 42501, anyone else not_found. Raises invalid_report_definition for anything outside the '
  'catalogue (never executed), range_too_large for a bad range or more than 10000 rows. 5 s statement timeout. '
  'Implemented in 4-RPT1 (#392).';

revoke execute on function api.run_report(jsonb, date, date) from public, anon, authenticated, service_role;
grant execute on function api.run_report(jsonb, date, date) to authenticated, service_role;

notify pgrst, 'reload schema';
