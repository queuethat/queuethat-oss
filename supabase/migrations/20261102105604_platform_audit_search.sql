-- #1133 (epic #1128): global platform audit search and export.
--
--   * api.platform_audit_search: operators see every row, support see only their own. aal2 for both.
--   * api.platform_audit_export: the same filters as CSV; the export is itself a platform_audit row.
--   * Contact data is masked in everything the API returns (display only: stored rows are untouched
--     and the table stays append-only).
--
-- Alternatives considered: (1) a client-side export that pages through the search and then reports
-- "I exported" would let a caller skip the audit row; the CSV is built where the audit row is
-- written. (2) A cursor on (at, id) would order by time exactly, but `at` is the transaction time
-- and ids are assigned at insert, so the two can disagree for concurrent transactions; id alone is
-- a stable keyset and is the order the log was appended in.

------------------------------------------------------------------------------------------------
-- Types
------------------------------------------------------------------------------------------------

create type api.platform_audit_row as (
  id bigint,
  at timestamptz,
  actor_id uuid,
  -- null for service-role actions (no actor) and for accounts that have since been deleted
  actor_email text,
  action text,
  org_id uuid,
  -- null when the row is not about an org, or the org no longer exists
  org_name text,
  reason text,
  support_grant_id uuid,
  break_glass_reason text,
  target jsonb
);

create type api.platform_audit_export as (
  csv text,
  row_count int,
  truncated boolean,
  next_after bigint
);

-- Actor lookups ("what did agent X do").
create index platform_audit_actor_idx on app.platform_audit (actor_id, id desc) where actor_id is not null;

------------------------------------------------------------------------------------------------
-- Masking
------------------------------------------------------------------------------------------------

/** Masks emails (keeping the domain), +international and North American phone numbers inside free text. */
create function private.mask_audit_text(p text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(
    regexp_replace(
      regexp_replace(p, '[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+)', '***@\1', 'g'),
      '\+[0-9][0-9 ().-]{5,}[0-9]', '[masked]', 'g'),
    '(^|[^0-9])\(?[0-9]{3}\)?[ .-][0-9]{3}[ .-][0-9]{4}($|[^0-9])', '\1[masked]\2', 'g')
$$;
comment on function private.mask_audit_text(text) is
  'Display masking for audit text: emails become ***@domain, phone numbers (+international, 204-555-0100 style) become [masked].';

/**
 * Masks contact data in an audit payload: everything under a contact-like key (email, phone,
 * mobile, contact, address, recipient, msisdn, sms) and any email or +phone inside any string.
 */
create function private.mask_audit_json(p_value jsonb, p_key text default null) returns jsonb
language plpgsql immutable set search_path = '' as $$
begin
  if p_value is null then
    return case when p_key is null then '{}'::jsonb end;
  end if;
  if p_key ~* '(^|[_-])(e?mails?|phones?|mobile|contacts?|address(es)?|recipients?|msisdn|sms)([_-]|$)'
     and jsonb_typeof(p_value) <> 'null' then
    return '"[masked]"'::jsonb;
  end if;
  return case jsonb_typeof(p_value)
    when 'object' then coalesce(
      (select jsonb_object_agg(e.key, private.mask_audit_json(e.value, e.key)) from jsonb_each(p_value) e), '{}')
    when 'array' then coalesce(
      (select jsonb_agg(private.mask_audit_json(e.value, p_key) order by e.ord)
       from jsonb_array_elements(p_value) with ordinality e(value, ord)), '[]')
    when 'string' then to_jsonb(private.mask_audit_text(p_value #>> '{}'))
    else p_value
  end;
end $$;
comment on function private.mask_audit_json(jsonb, text) is
  'Display masking for an audit payload; the stored row is never changed. A null payload is {}.';

/** One CSV cell: always quoted, quotes doubled, and a leading = + - @ tab or CR defused so a spreadsheet never runs it. */
create function private.csv_cell(p text) returns text
language sql immutable set search_path = '' as $$
  select case when p is null then ''
    else '"' || replace(case when p ~ E'^[=+\\-@\\t\\r]' then '''' || p else p end, '"', '""') || '"' end
$$;
comment on function private.csv_cell(text) is
  'Quotes one CSV text cell; empty for null; defuses spreadsheet formulas with a leading apostrophe.';

------------------------------------------------------------------------------------------------
-- The one query behind search and export
------------------------------------------------------------------------------------------------

/**
 * Filtered, masked audit rows, newest id first. p_own_only restricts to the caller's rows (support).
 * p_after is exclusive (rows with a smaller id); p_from inclusive, p_to exclusive. An action ending
 * in '.' matches the whole family ('support.'); anything else matches exactly. Callers validate.
 */
create function private.platform_audit_rows(
  p_own_only boolean, p_actor uuid, p_org_id uuid, p_action text,
  p_from timestamptz, p_to timestamptz, p_limit int, p_after bigint
) returns setof api.platform_audit_row
language sql stable set search_path = '' as $$
  select a.id, a.at, a.actor_id, u.email::text, a.action, a.org_id, o.name,
         private.mask_audit_text(a.reason),
         x.gid,
         private.mask_audit_text(coalesce(
           case when g.break_glass then g.reason end,
           case when a.action = 'support.break_glass' then a.reason end)),
         private.mask_audit_json(a.target)
  from app.platform_audit a
  left join auth.users u on u.id = a.actor_id
  left join app.organizations o on o.id = a.org_id
  cross join lateral (select case
      when a.target ->> 'support_grant_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (a.target ->> 'support_grant_id')::uuid end as gid) x
  left join app.support_grants g on g.id = x.gid
  where (not p_own_only or a.actor_id = (select auth.uid()))
    and (p_actor is null or a.actor_id = p_actor)
    and (p_org_id is null or a.org_id = p_org_id)
    and (nullif(btrim(p_action), '') is null
         or (right(btrim(p_action), 1) = '.' and left(a.action, length(btrim(p_action))) = btrim(p_action))
         or a.action = btrim(p_action))
    and (p_from is null or a.at >= p_from)
    and (p_to is null or a.at < p_to)
    and (p_after is null or a.id < p_after)
  order by a.id desc
  limit p_limit
$$;
comment on function private.platform_audit_rows(boolean, uuid, uuid, text, timestamptz, timestamptz, int, bigint) is
  'Shared query for api.platform_audit_search and api.platform_audit_export. Not callable by API roles.';

------------------------------------------------------------------------------------------------
-- RPCs
------------------------------------------------------------------------------------------------

create function api.platform_audit_search(
  p_actor uuid default null,
  p_org_id uuid default null,
  p_action text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit int default 50,
  p_after bigint default null
) returns setof api.platform_audit_row
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform('support');
  if p_limit is null or p_limit not between 1 and 200 or p_from > p_to then
    raise exception 'invalid_input';
  end if;
  return query
  select * from private.platform_audit_rows(
    not private.is_platform('operator'), p_actor, p_org_id, p_action, p_from, p_to, p_limit, p_after);
end $$;
comment on function api.platform_audit_search(uuid, uuid, text, timestamptz, timestamptz, int, bigint) is
  'Operator or support with aal2: platform_audit rows, newest first. Operators see every actor; '
  'support see only their own rows (asking for another actor gives an empty result). Filters are '
  'ANDed: actor, org, action (exact, or a family when it ends in a dot such as ''support.''), '
  'p_from inclusive and p_to exclusive as instants (callers convert local days to instants). '
  'Page with p_after = the last id seen. Contact data in the reason and payload is masked; '
  'support_grant_id and break_glass_reason are filled where the row refers to a grant. Reading '
  'is not itself audited. Raises permission_denied (42501) without a platform role and aal2, '
  'invalid_input for p_limit outside 1-200 or p_from after p_to.';

create function api.platform_audit_export(
  p_actor uuid default null,
  p_org_id uuid default null,
  p_action text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_after bigint default null
) returns api.platform_audit_export
language plpgsql volatile security definer set search_path = '' as $$
declare
  c_cap constant int := 10000;
  v_own boolean := not private.is_platform('operator');
  v_count int;
  v_truncated boolean;
  v_next bigint;
  v_csv text;
begin
  perform private.require_platform('support');
  if p_from > p_to then
    raise exception 'invalid_input';
  end if;

  with r as materialized (
    select * from private.platform_audit_rows(v_own, p_actor, p_org_id, p_action, p_from, p_to, c_cap + 1, p_after)
  ), kept as (
    select * from r order by id desc limit c_cap
  )
  select (select count(*) from kept),
         (select count(*) from r) > c_cap,
         (select min(id) from kept),
         (select string_agg(
            k.id || ',' || private.csv_cell(to_char(k.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
            || ',' || private.csv_cell(k.actor_id::text) || ',' || private.csv_cell(k.actor_email)
            || ',' || private.csv_cell(k.action) || ',' || private.csv_cell(k.org_id::text)
            || ',' || private.csv_cell(k.org_name) || ',' || private.csv_cell(k.reason)
            || ',' || private.csv_cell(k.support_grant_id::text) || ',' || private.csv_cell(k.break_glass_reason)
            || ',' || private.csv_cell(k.target::text), E'\r\n' order by k.id desc) from kept k)
  into v_count, v_truncated, v_next, v_csv;

  -- Written after the rows are read, so an export never lists itself.
  perform private.platform_audit('audit.export', p_org_id, jsonb_build_object(
    'actor', p_actor, 'action', p_action, 'from', p_from, 'to', p_to, 'after', p_after,
    'row_count', v_count, 'truncated', v_truncated,
    'scope', case when v_own then 'own' else 'all' end), null);

  return row(
    'id,at,actor_id,actor_email,action,org_id,org_name,reason,support_grant_id,break_glass_reason,target'
      || case when v_csv is null then '' else E'\r\n' || v_csv end,
    v_count, v_truncated, case when v_truncated then v_next end)::api.platform_audit_export;
end $$;
comment on function api.platform_audit_export(uuid, uuid, text, timestamptz, timestamptz, bigint) is
  'Operator or support with aal2: the filtered audit as CSV (same filters, scope and masking as '
  'platform_audit_search; times are UTC ISO 8601; cells that start like a spreadsheet formula '
  'are defused). At most 10,000 rows per call: when truncated is true, call again with p_after = '
  'next_after for the next part. Every call that returns is recorded as audit.export with its '
  'filters, row count and scope; a call that raises records nothing. Raises permission_denied '
  '(42501) without a platform role and aal2, invalid_input when p_from is after p_to.';

------------------------------------------------------------------------------------------------
-- Privileges
------------------------------------------------------------------------------------------------

revoke all on function private.mask_audit_text(text) from public, anon, authenticated;
revoke all on function private.mask_audit_json(jsonb, text) from public, anon, authenticated;
revoke all on function private.csv_cell(text) from public, anon, authenticated;
revoke all on function private.platform_audit_rows(boolean, uuid, uuid, text, timestamptz, timestamptz, int, bigint)
  from public, anon, authenticated;
revoke all on function api.platform_audit_search(uuid, uuid, text, timestamptz, timestamptz, int, bigint) from public, anon;
revoke all on function api.platform_audit_export(uuid, uuid, text, timestamptz, timestamptz, bigint) from public, anon;
grant execute on function api.platform_audit_search(uuid, uuid, text, timestamptz, timestamptz, int, bigint) to authenticated;
grant execute on function api.platform_audit_export(uuid, uuid, text, timestamptz, timestamptz, bigint) to authenticated;
