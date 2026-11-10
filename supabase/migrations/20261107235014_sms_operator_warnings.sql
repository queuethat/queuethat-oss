-- A4 (#1225): operators hear about a business BEFORE the SMS auto-pause, and get one daily digest.
--  * private.platform_sms_warning: the same stats and the same thresholds as private.platform_sms_breach
--    (both read private.platform_sms_threshold), at 60% of a threshold. It needs at least 2 messages in the
--    bucket, so one stray carrier filter on a small base never warns. Under 30 sent there is no verdict.
--  * ops.pause_unhealthy_platform_sms (every 5 minutes) emails every platform operator once per business,
--    metric and UTC day when a business that is not breaching reaches the warning level.
--  * ops.platform_sms_digest (daily 13:35 UTC) emails every operator yesterday's totals from
--    app.platform_sms_daily (A1), plus how many businesses are paused or were warned. Skipped on a day with
--    no messages, no pauses and no warnings.
--  * ops.purge_deleted_orgs no longer deletes app.platform_daily_stats rows: that table has no foreign key to
--    orgs and its comment says the counts outlive a deleted org; the purge deleted them anyway (found by A1).
-- Operator-only: no guest value reaches these emails (org name and counts), so no security-review label.
-- Alternative considered: a separate warning cron with its own scoring pass. Rejected: it would score every
-- org twice and a second job could drift from the pause job; the pause loop already holds the stats.

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled',
                     'slot_offer', 'reply_confirmed', 'reply_left', 'reply_commands', 'reply_multiple',
                     'reply_join', 'reply_join_closed', 'usage_alert', 'broadcast_marketing', 'report_summary',
                     'credit_low', 'receipt', 'reply_verify', 'payment_failed', 'payment_grace_ending',
                     'support_request', 'support_confirmation', 'appointment_expired', 'reply_confirm_number',
                     'sms_paused', 'sms_paused_operator', 'sms_warning_operator', 'sms_digest_operator'));
-- redefines notification_templates_trigger_check from 20261107210654_sms_pause_alerts.sql

insert into app.notification_templates (trigger, channel, category, subject, body) values
  ('sms_warning_operator', 'email', 'transactional', 'Platform SMS warning: {{org}} is near a pause ({{metric}})',
   '{{org}} ({{org_id}}) is at {{count}} of the {{limit}} that pauses platform SMS for {{metric}}. Last 24 hours: '
   '{{sent}} sent, {{stops}} STOP numbers, {{filtered}} carrier-filtered, {{undelivered}} undelivered. Nothing is '
   'paused yet. Look at the business in /platform before it is.'
   || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]'),
  ('sms_digest_operator', 'email', 'transactional', 'Platform SMS digest for {{day}}',
   'Platform SMS on {{day}} (UTC): {{messages}} messages, {{segments}} segments, {{delivered}} delivered, '
   '{{failed}} failed, {{filtered}} carrier-filtered, {{undelivered}} undelivered, {{stops}} STOP numbers. '
   'Cost {{cost}}, billed {{billed}}. Right now {{paused}} businesses are paused ({{auto_paused}} paused by the '
   'check in the last 24 hours) and {{warned}} were warned in the last 24 hours.'
   || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]');

-- One owner for the thresholds: the count of messages, out of p_sent, at which a metric pauses a business.
create function private.platform_sms_threshold(p_metric text, p_sent numeric) returns numeric
language sql immutable set search_path = '' as $$
  select case p_metric
    -- distinct phones, and never fewer than 3: one or two burner numbers cannot pause a small business
    when 'stop_rate' then greatest(3, 0.05 * p_sent)
    when 'filtered_rate' then 0.05 * p_sent
    when 'undelivered_rate' then 0.25 * p_sent
  end
$$;
revoke all on function private.platform_sms_threshold(text, numeric) from public, anon, authenticated;
comment on function private.platform_sms_threshold(text, numeric) is
  'Messages (of p_sent) at which the metric pauses platform SMS: stop_rate max(3, 5%), filtered_rate 5%, undelivered_rate 25%. Used by platform_sms_breach and platform_sms_warning.';

-- redefines private.platform_sms_breach from 20261107210654_sms_pause_alerts.sql
create or replace function private.platform_sms_breach(p_stats jsonb) returns text
language sql immutable set search_path = '' as $$
  select case
    when (p_stats ->> 'sent')::int < 30 then null
    when (p_stats ->> 'stops')::numeric >= private.platform_sms_threshold('stop_rate', (p_stats ->> 'sent')::numeric) then 'stop_rate'
    when (p_stats ->> 'filtered')::numeric >= private.platform_sms_threshold('filtered_rate', (p_stats ->> 'sent')::numeric) then 'filtered_rate'
    when (p_stats ->> 'undelivered')::numeric >= private.platform_sms_threshold('undelivered_rate', (p_stats ->> 'sent')::numeric) then 'undelivered_rate'
  end
$$;

create function private.platform_sms_warning(p_stats jsonb) returns text
language sql immutable set search_path = '' as $$
  select m.metric
  from (values (1, 'stop_rate', 'stops'), (2, 'filtered_rate', 'filtered'), (3, 'undelivered_rate', 'undelivered'))
       as m(ord, metric, key)
  where (p_stats ->> 'sent')::int >= 30
    and private.platform_sms_breach(p_stats) is null
    and (p_stats ->> m.key)::numeric >= 2
    and (p_stats ->> m.key)::numeric >= 0.6 * private.platform_sms_threshold(m.metric, (p_stats ->> 'sent')::numeric)
  order by m.ord
  limit 1
$$;
revoke all on function private.platform_sms_warning(jsonb) from public, anon, authenticated;
comment on function private.platform_sms_warning(jsonb) is
  'The first metric at 60% of its pause threshold (and at least 2 messages) while the business is not breaching, else null. Same stats and thresholds as platform_sms_breach.';

create function private.notify_sms_warning(p_org_id uuid, p_metric text, p_stats jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org app.organizations;
  v_day text := to_char(now() at time zone 'UTC', 'YYYYMMDD');
  v_limit numeric := private.platform_sms_threshold(p_metric, (p_stats ->> 'sent')::numeric);
  v_key text := case p_metric when 'stop_rate' then 'stops' when 'filtered_rate' then 'filtered' else 'undelivered' end;
begin
  select * into v_org from app.organizations where id = p_org_id;
  if not found then return; end if;
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category,
                                 vars, dedupe_key)
  select p_org_id, null, 'email', r.user_id, 'sms_warning_operator', t.version, t.category,
         jsonb_build_object('org', v_org.name, 'org_id', p_org_id, 'metric', p_metric,
                            'count', p_stats -> v_key, 'limit', ceil(v_limit),
                            'sent', p_stats -> 'sent', 'stops', p_stats -> 'stops',
                            'filtered', p_stats -> 'filtered', 'undelivered', p_stats -> 'undelivered'),
         'sms_warning_operator:' || p_org_id || ':' || p_metric || ':' || v_day || ':' || r.user_id
  from app.platform_roles r
  join auth.users u on u.id = r.user_id and u.email is not null
  cross join lateral private.resolve_template(p_org_id, null, 'sms_warning_operator', 'email', 'en') t
  where r.role = 'operator'
  on conflict (dedupe_key) do nothing;
end $$;
comment on function private.notify_sms_warning(uuid, text, jsonb) is
  'Queues the pre-pause warning to every platform operator, once per org, metric and UTC day. Called by ops.pause_unhealthy_platform_sms only.';
revoke all on function private.notify_sms_warning(uuid, text, jsonb) from public, anon, authenticated;

-- redefines ops.pause_unhealthy_platform_sms from 20261107210654_sms_pause_alerts.sql
create or replace function ops.pause_unhealthy_platform_sms() returns int
language plpgsql volatile set search_path = '' as $$
declare
  o record;
  v_stats jsonb;
  v_why text;
  v_warn text;
  v_count int := 0;
begin
  for o in
    select s.org_id from app.provider_settings s
    where s.channel = 'sms' and s.mode = 'platform' and s.enabled
      and not exists (select 1 from private.platform_sms_pauses p
                      where p.org_id = s.org_id and (p.state in ('auto', 'manual') or p.set_at > now() - interval '24 hours'))
  loop
    v_stats := private.platform_sms_stats(o.org_id);
    v_why := private.platform_sms_breach(v_stats);
    if v_why is not null then
      insert into private.platform_sms_pauses (org_id, state, reason, stats)
      values (o.org_id, 'auto', v_why, v_stats)
      on conflict (org_id) do update set state = 'auto', reason = excluded.reason, stats = excluded.stats, set_at = now(), set_by = null;
      perform private.platform_audit('sms.auto_pause', o.org_id, v_stats || jsonb_build_object('breach', v_why), v_why);
      perform private.notify_sms_paused(o.org_id, v_why, v_stats);
      v_count := v_count + 1;
    else
      v_warn := private.platform_sms_warning(v_stats);
      if v_warn is not null then
        perform private.notify_sms_warning(o.org_id, v_warn, v_stats);
      end if;
    end if;
  end loop;
  delete from private.platform_sms_stops where at < now() - interval '3 days';
  return v_count;
end $$;

create function ops.platform_sms_digest() returns int
language plpgsql volatile set search_path = '' as $$
declare
  v_day date := (now() at time zone 'UTC')::date - 1;
  v_totals record;
  v_paused int;
  v_auto int;
  v_warned int;
  v_sent int;
begin
  select coalesce(sum(messages), 0) as messages, coalesce(sum(segments), 0) as segments,
         coalesce(sum(delivered), 0) as delivered, coalesce(sum(failed), 0) as failed,
         coalesce(sum(filtered), 0) as filtered, coalesce(sum(undelivered), 0) as undelivered,
         coalesce(sum(stops), 0) as stops, coalesce(sum(cost_micros), 0) as cost, coalesce(sum(billed_micros), 0) as billed
  into v_totals from app.platform_sms_daily where day = v_day;
  select count(*) filter (where state in ('auto', 'manual')),
         count(*) filter (where state = 'auto' and set_at > now() - interval '24 hours')
  into v_paused, v_auto from private.platform_sms_pauses;
  select count(distinct org_id) into v_warned from app.notifications
  where template_key = 'sms_warning_operator' and created_at > now() - interval '24 hours';
  if v_totals.messages = 0 and v_paused = 0 and v_warned = 0 then return 0; end if;
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category,
                                 vars, dedupe_key)
  select (select o.id from app.organizations o order by o.created_at limit 1), null, 'email', r.user_id,
         'sms_digest_operator', t.version, t.category,
         jsonb_build_object('day', v_day, 'messages', v_totals.messages, 'segments', v_totals.segments,
                            'delivered', v_totals.delivered, 'failed', v_totals.failed,
                            'filtered', v_totals.filtered, 'undelivered', v_totals.undelivered,
                            'stops', v_totals.stops,
                            'cost', '$' || to_char(v_totals.cost / 1e6, 'FM999999990.00'),
                            'billed', '$' || to_char(v_totals.billed / 1e6, 'FM999999990.00'),
                            'paused', v_paused, 'auto_paused', v_auto, 'warned', v_warned),
         'sms_digest_operator:' || v_day || ':' || r.user_id
  from app.platform_roles r
  join auth.users u on u.id = r.user_id and u.email is not null
  cross join lateral private.resolve_template(null, null, 'sms_digest_operator', 'email', 'en') t
  where r.role = 'operator'
  on conflict (dedupe_key) do nothing;
  get diagnostics v_sent = row_count;
  return v_sent;
end $$;
revoke all on function ops.platform_sms_digest() from public, anon, authenticated;
comment on function ops.platform_sms_digest() is
  'Cron, daily 13:35 UTC: emails every platform operator yesterday''s SMS totals (app.platform_sms_daily) and pause/warning counts. Skipped when there is nothing to report. Idempotent per day. Returns emails queued.';
select cron.schedule('platform-sms-digest', '35 13 * * *', 'select ops.platform_sms_digest()');

-- redefines ops.purge_deleted_orgs from 20261107212632_sms_analytics_rollup.sql
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
    -- app.platform_daily_stats has the same contract (no foreign key, its comment says the counts outlive the org)
    and c.table_name not in ('platform_sms_daily', 'platform_daily_stats');

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
