-- W5 (#1307, tracker #1267): owners are told 30 days before waiver records are deleted, so they can export.
--
-- A daily sweep finds organisations holding acceptance records whose deletion date (accepted_at plus the
-- organisation's waiver_retention_days, W7) falls in the next 30 days, and queues one email to the owners
-- through the outbox (I-11, owners only, via private.enqueue_account_email). One email per organisation per
-- calendar month: the dedupe scope is the month, so a long window does not mail daily. The purge itself
-- (ops.waiver_retention_tick) is untouched and runs on schedule: the reminder never delays it.
-- Nothing a guest typed reaches the message: the variables are the organisation name, a count and a date.
-- Alternative rejected: reminding per record (a flood of mail). Interface: a cron-only ops function, no new
-- entry point.
-- The constraint below is copied from 20261109161923_guest_incident_notice.sql with one trigger added.

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled',
                     'slot_offer', 'reply_confirmed', 'reply_left', 'reply_commands', 'reply_multiple',
                     'reply_join', 'reply_join_closed', 'usage_alert', 'broadcast_marketing', 'report_summary',
                     'credit_low', 'receipt', 'reply_verify', 'payment_failed', 'payment_grace_ending',
                     'support_request', 'support_confirmation', 'appointment_expired', 'reply_confirm_number',
                     'sms_paused', 'sms_paused_operator', 'sms_warning_operator', 'sms_digest_operator',
                     'incident_notice', 'incident_reported_operator', 'guest_incident_notice',
                     'waiver_records_expiring'));

insert into app.notification_templates (trigger, channel, category, subject, body) values
  ('waiver_records_expiring', 'email', 'transactional', '{org}: waiver records will be deleted soon',
   '{count} signed waiver records for {org} will be deleted by {first_date}, because of the waiver retention period '
   'you set. Export them before then if you need to keep them: open Forms in your admin console (/admin/forms), '
   'find Waiver records, and download the CSV. You can also lengthen the retention period there.'
   || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]');

create function ops.send_waiver_purge_reminders() returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  r record;
  n int := 0;
  v_before int;
begin
  for r in
    select o.id as org_id, o.name, count(*)::int as expiring,
           min(w.accepted_at + make_interval(days => o.waiver_retention_days)) as first_at
    from app.organizations o
    join app.waiver_acceptances w on w.org_id = o.id
    where w.accepted_at + make_interval(days => o.waiver_retention_days) <= now() + interval '30 days'
    group by o.id, o.name
  loop
    select count(*) into v_before from app.notifications x
    where x.org_id = r.org_id and x.template_key = 'waiver_records_expiring';
    perform private.enqueue_account_email(
      r.org_id, 'waiver_records_expiring',
      jsonb_build_object('org', r.name, 'count', r.expiring::text,
                         'first_date', to_char(r.first_at at time zone 'UTC', 'FMMonth FMDD, YYYY') || ' UTC'),
      concat_ws(':', 'waiver_expiring', r.org_id, to_char(now() at time zone 'UTC', 'YYYY-MM')));
    n := n + (select count(*) from app.notifications x
              where x.org_id = r.org_id and x.template_key = 'waiver_records_expiring') - v_before;
  end loop;
  return n;
end $$;
comment on function ops.send_waiver_purge_reminders() is
  'Cron only: emails the owners of every organisation that has waiver records due for deletion within 30 days, '
  'once per organisation per calendar month. Returns emails queued; a repeat run in the same month returns 0.';
revoke all on function ops.send_waiver_purge_reminders() from public, anon, authenticated;
select cron.schedule('waiver-purge-reminders', '27 14 * * *', 'select ops.send_waiver_purge_reminders()');
