-- #1205 (messaging review M4): a platform SMS pause was silent (the owner's guests just stopped getting texts and
-- no operator was told), and the STOP threshold was 3% of sent, low for a queue product where guests often
-- STOP after the visit. Now, when the job pauses a business:
--  * every owner and admin of the org gets an email saying texts are paused, why, and how to get help;
--  * every platform operator gets an email naming the org and the breach (the audit row already exists);
--  * the STOP rate threshold is 5% (still at least 3 distinct numbers) until pilot data exists.
-- Not done here, and said plainly: a rival can still trigger a pause with three burner numbers; this makes
-- the pause visible within one job run so an operator can resume it (api.platform_set_sms_pause) after
-- checking the audit log. Excluding STOPs by timing is easy to evade, so it is not attempted. The
-- tenant-facing banner belongs to the SMS setup flow (plan T1).
alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled',
                     'slot_offer', 'reply_confirmed', 'reply_left', 'reply_commands', 'reply_multiple',
                     'reply_join', 'reply_join_closed', 'usage_alert', 'broadcast_marketing', 'report_summary',
                     'credit_low', 'receipt', 'reply_verify', 'payment_failed', 'payment_grace_ending',
                     'support_request', 'support_confirmation', 'appointment_expired', 'reply_confirm_number',
                     'sms_paused', 'sms_paused_operator'));
-- redefines notification_templates_trigger_check from 20261107205516_staff_number_confirm.sql

insert into app.notification_templates (trigger, channel, category, subject, body) values
  ('sms_paused', 'email', 'transactional', '{{org}}: text messages are paused',
   'Text messages from {{org}} are paused because {{reason}}. Guests still see their place in line on the status '
   'page, and push and email alerts are unaffected. Our team has been told and will review this; reply to this '
   'email or use Contact support in your admin console if you think this is a mistake.'
   || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]'),
  ('sms_paused_operator', 'email', 'transactional', 'Platform SMS paused: {{org}} ({{breach}})',
   'The automatic check paused platform SMS for {{org}} ({{org_id}}): {{breach}}. Last 24 hours: {{sent}} sent, '
   '{{stops}} STOP numbers, {{filtered}} carrier-filtered, {{undelivered}} undelivered. Review the audit log '
   'for a rival pattern (STOPs from numbers that joined minutes earlier) before resuming with '
   'api.platform_set_sms_pause.'
   || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]');

create function private.notify_sms_paused(p_org_id uuid, p_breach text, p_stats jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org app.organizations;
  v_stamp text := to_char(now() at time zone 'UTC', 'YYYYMMDDHH24MISS');
  v_reason text := case p_breach
    when 'stop_rate' then 'too many guests replied STOP'
    when 'filtered_rate' then 'phone carriers filtered too many of its messages'
    else 'too many of its messages could not be delivered' end;
begin
  select * into v_org from app.organizations where id = p_org_id;
  if not found then return; end if;
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category,
                                 vars, dedupe_key)
  select p_org_id, null, 'email', m.user_id, t.trigger, t.version, t.category,
         jsonb_build_object('org', v_org.name, 'reason', v_reason),
         'sms_paused:' || p_org_id || ':' || v_stamp || ':' || m.user_id
  from app.memberships m
  join auth.users u on u.id = m.user_id and u.email is not null
  cross join lateral private.resolve_template(p_org_id, null, 'sms_paused', 'email', v_org.default_locale) t
  where m.org_id = p_org_id and m.role in ('owner', 'admin')
  on conflict (dedupe_key) do nothing;
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category,
                                 vars, dedupe_key)
  select p_org_id, null, 'email', r.user_id, 'sms_paused_operator', t.version, t.category,
         jsonb_build_object('org', v_org.name, 'org_id', p_org_id, 'breach', p_breach,
                            'sent', p_stats -> 'sent', 'stops', p_stats -> 'stops',
                            'filtered', p_stats -> 'filtered', 'undelivered', p_stats -> 'undelivered'),
         'sms_paused_operator:' || p_org_id || ':' || v_stamp || ':' || r.user_id
  from app.platform_roles r
  join auth.users u on u.id = r.user_id and u.email is not null
  cross join lateral private.resolve_template(p_org_id, null, 'sms_paused_operator', 'email', 'en') t
  where r.role = 'operator'
  on conflict (dedupe_key) do nothing;
end $$;
comment on function private.notify_sms_paused(uuid, text, jsonb) is
  'Queues the pause emails: the org''s owners and admins, and every platform operator. Idempotent per pause. Called by ops.pause_unhealthy_platform_sms only.';
revoke all on function private.notify_sms_paused(uuid, text, jsonb) from public, anon, authenticated;

-- redefines private.platform_sms_breach from 20261102085037_platform_sms_auto_pause.sql
create or replace function private.platform_sms_breach(p_stats jsonb) returns text
language sql immutable set search_path = '' as $$
  select case
    when (p_stats ->> 'sent')::int < 30 then null
    -- distinct phones, and never fewer than 3: one or two burner numbers cannot pause a small business
    when (p_stats ->> 'stops')::numeric >= greatest(3, 0.05 * (p_stats ->> 'sent')::numeric) then 'stop_rate'
    when (p_stats ->> 'filtered')::numeric >= 0.05 * (p_stats ->> 'sent')::numeric then 'filtered_rate'
    when (p_stats ->> 'undelivered')::numeric >= 0.25 * (p_stats ->> 'sent')::numeric then 'undelivered_rate'
  end
$$;

-- redefines ops.pause_unhealthy_platform_sms from 20261102085037_platform_sms_auto_pause.sql
create or replace function ops.pause_unhealthy_platform_sms() returns int
language plpgsql volatile set search_path = '' as $$
declare
  o record;
  v_stats jsonb;
  v_why text;
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
    end if;
  end loop;
  delete from private.platform_sms_stops where at < now() - interval '3 days';
  return v_count;
end $$;
