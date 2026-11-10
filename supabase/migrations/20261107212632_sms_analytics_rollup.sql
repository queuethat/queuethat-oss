-- A1 (#1222): daily SMS rollup for the operator console and api.platform_sms_analytics.
--
-- Why a new table and RPC: app.platform_daily_stats has no channel, template, locale, country or cost
-- column, and api.platform_stats is a fixed signature, so these dimensions cannot ride on it.
--
-- Days are UTC days, like platform_daily_stats. A message counts on the day it was created; delivery
-- receipts arrive late, so the last three days (today and the two before) are recomputed every run.
-- Rows have no foreign key to orgs and are never deleted: history survives purge-org and the
-- retention purge of app.notifications.

------------------------------------------------------------------------------------------------
-- Table
------------------------------------------------------------------------------------------------

create table app.platform_sms_daily (
  day date not null,
  -- No foreign key: the counts outlive a deleted org, like platform_audit.
  org_id uuid not null,
  -- '' on rows that carry only guest events (STOP, OTP, opt-in), which have no template.
  template_key text not null default '',
  locale text not null default '',
  -- Calling-code country; a shared code lists them all ('CA/US'); '' when unknown.
  country text not null default '',
  messages int not null default 0,
  segments int not null default 0,
  delivered int not null default 0,
  failed int not null default 0,
  filtered int not null default 0,
  undelivered int not null default 0,
  suppressed int not null default 0,
  -- Provider cost and what the tenant was charged (cost + margin), millionths of the platform currency.
  cost_micros bigint not null default 0,
  billed_micros bigint not null default 0,
  stops int not null default 0,
  -- Always 0 today: Twilio answers HELP itself and the webhook route never sees it.
  helps int not null default 0,
  optins int not null default 0,
  otp_sent int not null default 0,
  otp_verified int not null default 0,
  computed_at timestamptz not null default now(),
  primary key (day, org_id, template_key, locale, country)
);
create index platform_sms_daily_org_idx on app.platform_sms_daily (org_id, day);

------------------------------------------------------------------------------------------------
-- Rollup
------------------------------------------------------------------------------------------------

-- Longest gap one run fills; older missed days stay empty rather than making one run slow.
create function private.platform_sms_backfill_days() returns int
language sql immutable set search_path = '' as $$ select 31 $$;

-- Country label for an E.164 number: the calling code's countries, sorted, joined with '/'.
create function private.platform_sms_country(p_e164 text) returns text
language sql stable set search_path = '' as $$
  select coalesce((select string_agg(c, '/' order by c) from unnest(private.phone_countries(p_e164)) c), '')
$$;

create function private.platform_sms_rollup(p_today date) returns int
language plpgsql volatile set search_path = '' as $$
declare
  -- Always the last three days; further back only the days after the last one computed.
  first_day date := greatest(
    least(coalesce((select max(day) + 1 from app.platform_sms_daily), p_today - private.platform_sms_backfill_days()),
          p_today - 2),
    p_today - private.platform_sms_backfill_days());
  v_from timestamptz := first_day::timestamp at time zone 'UTC';
  v_to timestamptz := (p_today + 1)::timestamp at time zone 'UTC';
  written int;
begin
  with msgs as (
    select (n.created_at at time zone 'UTC')::date as day, n.org_id, n.template_key,
           coalesce(v.locale, '') as locale, private.platform_sms_country(gc.value) as country,
           count(*) as messages,
           coalesce(sum(n.segments), 0) as segments,
           count(*) filter (where n.delivery_status = 'delivered') as delivered,
           count(*) filter (where n.status = 'dead') as failed,
           -- filtered and undelivered use the same tests as private.platform_sms_stats (the pause maths)
           count(*) filter (where n.status = 'sent' and n.error_code = 'twilio_30007') as filtered,
           count(*) filter (where n.status = 'sent' and n.delivery_status in ('undelivered', 'failed')
                              and coalesce(n.error_code, '') not in ('twilio_30007', 'twilio_30003', 'twilio_30005', 'twilio_30006')) as undelivered,
           count(*) filter (where n.status = 'suppressed') as suppressed,
           coalesce(sum(n.cost_micros), 0) as cost_micros,
           coalesce(sum(-l.amount_micros), 0) as billed_micros
    from app.notifications n
    left join app.visits v on v.org_id = n.org_id and v.id = n.visit_id
    left join app.guest_contacts gc on gc.org_id = n.org_id and gc.id = n.recipient_ref and gc.channel = 'phone'
    left join app.credit_ledger l on l.notification_id = n.id and l.entry_type = 'debit'
    where n.channel = 'sms' and n.created_at >= v_from and n.created_at < v_to
    group by 1, 2, 3, 4, 5
  ), events as (
    -- Guest events have no template or locale. STOPs and OTP requests live in tables that are pruned
    -- after one to three days, so the upsert below never lowers what an earlier run already stored.
    select s.day, s.org_id, s.country, sum(s.stops)::int as stops, sum(s.optins)::int as optins,
           sum(s.otp_sent)::int as otp_sent, sum(s.otp_verified)::int as otp_verified
    from (
      select (p.at at time zone 'UTC')::date as day, p.org_id, private.platform_sms_country(p.phone) as country,
             count(distinct p.phone) as stops, 0 as optins, 0 as otp_sent, 0 as otp_verified
      from private.platform_sms_stops p where p.at >= v_from and p.at < v_to group by 1, 2, 3
      union all
      select (c.captured_at at time zone 'UTC')::date, c.org_id, private.platform_sms_country(gc.value), 0, count(*), 0, 0
      from app.consents c
      join app.guest_contacts gc on gc.org_id = c.org_id and gc.id = c.contact_id
      where c.channel = 'sms' and c.status = 'granted' and c.captured_at >= v_from and c.captured_at < v_to
      group by 1, 2, 3
      union all
      select (a.at at time zone 'UTC')::date, v.org_id, '', 0, 0, count(*), 0
      from private.phone_code_attempts a join app.visits v on v.id = a.visit_id
      where a.kind = 'request' and a.at >= v_from and a.at < v_to group by 1, 2
      union all
      select (gc.verified_at at time zone 'UTC')::date, gc.org_id, private.platform_sms_country(gc.value), 0, 0, 0, count(*)
      from app.guest_contacts gc
      where gc.channel = 'phone' and gc.verified_at >= v_from and gc.verified_at < v_to group by 1, 2, 3
    ) s
    group by 1, 2, 3
  ), rows as (
    insert into app.platform_sms_daily as d
      (day, org_id, template_key, locale, country, messages, segments, delivered, failed, filtered, undelivered,
       suppressed, cost_micros, billed_micros, stops, optins, otp_sent, otp_verified)
    select m.day, m.org_id, m.template_key, m.locale, m.country, m.messages, m.segments, m.delivered, m.failed,
           m.filtered, m.undelivered, m.suppressed, m.cost_micros, m.billed_micros, 0, 0, 0, 0
    from msgs m
    union all
    select e.day, e.org_id, '', '', e.country, 0, 0, 0, 0, 0, 0, 0, 0, 0, e.stops, e.optins, e.otp_sent, e.otp_verified
    from events e
    on conflict (day, org_id, template_key, locale, country) do update set
      messages = excluded.messages, segments = excluded.segments, delivered = excluded.delivered,
      failed = excluded.failed, filtered = excluded.filtered, undelivered = excluded.undelivered,
      suppressed = excluded.suppressed, cost_micros = excluded.cost_micros, billed_micros = excluded.billed_micros,
      -- sources pruned before the window ends: keep the larger of what was stored and what is left
      stops = greatest(d.stops, excluded.stops), otp_sent = greatest(d.otp_sent, excluded.otp_sent),
      optins = excluded.optins, otp_verified = excluded.otp_verified,
      computed_at = now()
    returning 1
  )
  select count(*)::int into written from rows;
  return written;
end $$;
comment on function private.platform_sms_rollup(date) is
  'ops.platform_sms_tick() as if today were p_today: recomputes the last three UTC days (late delivery '
  'receipts) and any older days after the last one computed, at most 31 back. Upserts one row per day, org, '
  'template, locale and country; rows whose source rows were purged are left alone, and STOP and OTP-request '
  'counts only ever grow (their sources are pruned). Running it twice leaves identical rows. Returns rows written.';

create function ops.platform_sms_tick() returns int
language sql volatile set search_path = '' as $$
  select private.platform_sms_rollup((now() at time zone 'UTC')::date)
$$;
comment on function ops.platform_sms_tick() is
  'Fills app.platform_sms_daily through today (UTC). Idempotent. Run hourly at :20 by pg_cron (job platform-sms-tick).';

revoke all on function private.platform_sms_backfill_days() from public, anon, authenticated;
revoke all on function private.platform_sms_country(text) from public, anon, authenticated;
revoke all on function private.platform_sms_rollup(date) from public, anon, authenticated;
revoke all on function ops.platform_sms_tick() from public, anon, authenticated;

select cron.schedule('platform-sms-tick', '20 * * * *', 'select ops.platform_sms_tick()');

------------------------------------------------------------------------------------------------
-- api.platform_sms_analytics
------------------------------------------------------------------------------------------------

create function api.platform_sms_analytics(p_from date, p_to date, p_org_id uuid default null)
returns setof app.platform_sms_daily
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_platform('support');
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 365 then
    raise exception 'invalid_input';
  end if;
  perform private.platform_audit('sms.analytics.read', p_org_id,
    jsonb_build_object('from', p_from, 'to', p_to), null);
  return query
    select * from app.platform_sms_daily s
    where s.day between p_from and p_to and (p_org_id is null or s.org_id = p_org_id)
    order by s.day, s.org_id, s.template_key, s.locale, s.country;
end $$;
comment on function api.platform_sms_analytics(date, date, uuid) is
  'Support or operator (aal2). The SMS rollup rows (counts, segments, cost, billed; one per day, org, template, '
  'locale and country) for UTC days p_from..p_to inclusive, at most 366 days, optionally for one org (a purged '
  'org still has history). Counts only: no numbers, bodies or variables. Every call is written to platform_audit '
  '(sms.analytics.read). Raises permission_denied (42501) without a platform role and aal2, invalid_input for '
  'a missing, reversed or too long range.';

revoke all on function api.platform_sms_analytics(date, date, uuid) from public, anon;
grant execute on function api.platform_sms_analytics(date, date, uuid) to authenticated;

------------------------------------------------------------------------------------------------
-- Privileges and row-level security
------------------------------------------------------------------------------------------------

revoke all on app.platform_sms_daily from public, anon, authenticated, service_role;
grant select on app.platform_sms_daily to authenticated;

alter table app.platform_sms_daily enable row level security;

create policy platform_sms_daily_select on app.platform_sms_daily for select to authenticated
  using ((select private.is_platform('support')));

------------------------------------------------------------------------------------------------
-- The purge must not delete the rollup
------------------------------------------------------------------------------------------------

-- redefines ops.purge_deleted_orgs from 20261030080000_purge_org_kick.sql
create or replace function ops.purge_deleted_orgs() returns int
language plpgsql volatile set search_path = '' as $$
declare
  v_due uuid[];
  v_org uuid;
  v_requested timestamptz;
  v_tables text[];
  v_pending text[];
  v_next text[];
  t text;
  n int := 0;
begin
  select array_agg(c.table_name order by c.table_name) into v_tables
  from information_schema.columns c
  join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
  where c.table_schema = 'app' and c.column_name = 'org_id' and x.table_type = 'BASE TABLE'
    -- the operator SMS rollup is counts keyed by an id: it outlives the org by design (like platform_audit)
    and c.table_name <> 'platform_sms_daily';

  -- Read up front: the loop below alters tables, which fails while a cursor on them is open.
  -- Orgs whose storage files and device users are not gone yet are handed to purge-org first;
  -- the function reports back through api.mark_org_purged_externally and the next run purges.
  perform private.kick_purge_org(o.id) from app.organizations o
  where o.status = 'pending_deletion' and o.deletion_scheduled_for <= now() and o.external_purged_at is null;
  select coalesce(array_agg(id), '{}') into v_due from app.organizations
  where status = 'pending_deletion' and deletion_scheduled_for <= now() and external_purged_at is not null;
  foreach v_org in array v_due loop
    select deletion_requested_at into v_requested from app.organizations where id = v_org;
    begin -- one org's failure rolls back only that org and leaves the others to purge
    foreach t in array v_tables || 'organizations'::text loop
      execute format('alter table app.%I disable trigger user', t);
    end loop;
    -- Foreign keys stay enforced: a table that still has children is retried after them.
    v_pending := v_tables;
    for i in 1..20 loop
      v_next := '{}';
      foreach t in array v_pending loop
        begin
          execute format('delete from app.%I where org_id = $1', t) using v_org;
        exception when foreign_key_violation then
          v_next := v_next || t;
        end;
      end loop;
      v_pending := v_next;
      exit when cardinality(v_pending) = 0;
    end loop;
    if cardinality(v_pending) > 0 then
      raise exception 'purge_incomplete' using detail = array_to_string(v_pending, ',');
    end if;
    delete from app.organizations where id = v_org;
    foreach t in array v_tables || 'organizations'::text loop
      execute format('alter table app.%I enable trigger user', t);
    end loop;
    insert into ops.org_deletion_log (org_id, requested_at) values (v_org, v_requested);
    n := n + 1;
    exception when others then
      raise warning 'purge_deleted_orgs: org % failed: %', v_org, sqlerrm;
    end;
  end loop;
  return n;
end $$;
