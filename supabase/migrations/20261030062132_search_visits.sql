-- 2A-ST7 (#140): api.search_visits (technical-design.md 3.5; compliance STRIDE S-9).
--
-- Phone search is a bulk-exfiltration path, so it is bounded: at most 7 service days, a minimum
-- query length, call limits per user and location, and results are visit rows, which carry no contact
-- value at all.

-- One row per search call, for the per-user rate limit. Not exposed; only definer functions touch it.
create table private.search_log (
  user_id uuid not null,
  location_id uuid not null,
  phone boolean not null default false,
  at timestamptz not null default now()
);
create index search_log_user_idx on private.search_log (user_id, at);
create index search_log_location_idx on private.search_log (location_id, at);
create index search_log_at_idx on private.search_log (at);
revoke all on private.search_log from public, anon, authenticated;

create function ops.purge_search_log() returns int
language sql volatile set search_path = '' as $$
  with d as (delete from private.search_log where at < now() - interval '1 hour' returning 1)
  select count(*)::int from d
$$;
comment on function ops.purge_search_log() is
  'Deletes search_log rows older than an hour. Run every 10 minutes by pg_cron; returns rows deleted.';
select cron.schedule('purge-search-log', '*/10 * * * *', 'select ops.purge_search_log()');

-- redefines api.search_visits from 20261030045508_api_contracts_2a.sql
-- Volatile now (it records the call for the rate limit); the signature is unchanged.
create or replace function api.search_visits(p_location_id uuid, p_query text, p_days int default 1, p_limit int default 20)
returns setof api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  loc app.locations;
  v_q text := btrim(coalesce(p_query, ''));
  v_digits text := regexp_replace(coalesce(p_query, ''), '\D', '', 'g');
  v_phone boolean;
  v_like text;
  v_from date;
begin
  select * into loc from app.locations where id = p_location_id;
  if not found or not private.has_role(loc.org_id, loc.id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_days is null or p_days not between 1 and 7 or p_limit is null or p_limit < 1
     or length(v_q) < 2 or length(v_q) > 80 then
    raise exception 'invalid_input';
  end if;

  -- A query made only of digits and phone punctuation is a phone number; under four digits it
  -- matches tickets and names only, never a phone.
  v_phone := v_q ~ '^[0-9+()[:space:].-]+$' and length(v_digits) >= 4;

  -- Serialize one user's calls so parallel connections cannot all pass the count. Limits: 30
  -- calls a minute per user, 10 phone-mode calls a minute per user and 120 a minute per
  -- location, so many accounts cannot walk the digit space of a location's phones either.
  perform pg_advisory_xact_lock(hashtextextended((select auth.uid())::text, 0));
  insert into private.search_log (user_id, location_id, phone) values ((select auth.uid()), loc.id, v_phone);
  if (select count(*) from private.search_log
      where user_id = (select auth.uid()) and at > now() - interval '1 minute') > 30
     or (v_phone and (select count(*) from private.search_log
                      where user_id = (select auth.uid()) and phone and at > now() - interval '1 minute') > 10)
     or (select count(*) from private.search_log
         where location_id = loc.id and at > now() - interval '1 minute') > 120 then
    raise exception 'rate_limited';
  end if;
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_from := private.service_day(loc.id) - (p_days - 1);

  return query
    select (private.visit_row(x.id)).*
    from (
      select v.id, v.joined_at
      from app.visits v
      left join app.services s on s.id = v.service_id
      where v.location_id = loc.id and v.org_id = loc.org_id and v.service_day >= v_from
        and (v.guest_name ilike v_like
             or v.display_ticket ilike v_like
             or s.name ilike v_like
             or (v_phone and exists (
                   select 1 from app.guest_contacts c
                   where c.id = v.contact_id and c.org_id = v.org_id and c.channel = 'phone'
                     and right(c.value, length(v_digits)) = v_digits)))
      order by v.joined_at desc, v.id
      limit least(p_limit, 50)
    ) x
    order by x.joined_at desc, x.id;
end $$;
comment on function api.search_visits(uuid, text, int, int) is
  'Visits of the location from the last p_days service days (1 to 7) whose guest name, ticket or '
  'service name contains p_query (case-insensitive), or, when p_query is a phone number of at '
  'least 4 digits, whose phone ends with those digits; newest first, at most min(p_limit, 50). '
  'Rows are the usual api.visit_row: no contact value is ever returned. Staff of the location. '
  'Raises invalid_input for a query under 2 or over 80 characters or p_days outside 1 to 7, '
  'rate_limited after 30 calls a minute per user (10 for phone numbers) or 120 per location, not_found for a foreign location. '
  'Implemented in 2A-ST7 (#140).';

notify pgrst, 'reload schema';
