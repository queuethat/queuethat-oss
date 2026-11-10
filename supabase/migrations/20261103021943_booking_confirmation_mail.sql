-- Booking mail the audit found missing: nothing ever sent appointment_confirmed, and an unpaid booking that
-- lapsed told the guest nothing. A guest booking that becomes confirmed (at once when no card is due, when
-- the card step succeeds, or when a waitlist offer is claimed) queues appointment_confirmed; one that lapses
-- unpaid queues appointment_expired. Both go through private.enqueue_appointment_notification, so they reach
-- the typed email (never a typed phone) under the same per-address cap, suppression list, quiet hours and
-- relevance checks as reminders, and carry the manage links minted at claim time. Staff, event and series
-- bookings send nothing here.
-- Alternatives rejected: (1) enqueue inside api.book_appointment, which misses the card and waitlist paths;
-- (2) a polling job, which adds latency and a second place that decides "confirmed".
-- redefines notification_templates_trigger_check from 20261102075216_contact_support.sql
-- redefines api.outbox_still_relevant from 20261030220519_sms_commands.sql

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled',
                     'slot_offer', 'reply_confirmed', 'reply_left', 'reply_commands', 'reply_multiple',
                     'reply_join', 'reply_join_closed', 'usage_alert', 'broadcast_marketing', 'report_summary',
                     'credit_low', 'receipt', 'reply_verify', 'payment_failed', 'payment_grace_ending',
                     'support_request', 'support_confirmation', 'appointment_expired'));

insert into app.notification_templates (trigger, channel, subject, body)
select 'appointment_expired', c.channel, case when c.channel = 'email' then 'Your booking was released' end,
       'Your {{service}} booking at {{location_name}} for {{appointment_time}} was released because the card step was not completed. The time is open again.[ Book again: {manage_url}]' || c.suffix
from (values ('push'::app.notification_channel, ''), ('console'::app.notification_channel, ''),
             ('sms'::app.notification_channel, ''),
             ('email'::app.notification_channel, E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]')) c (channel, suffix);

create or replace function api.outbox_still_relevant(p_outbox_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce((
    select (case
      -- A cancelled event's message is about the cancellation; it stands while the booking is cancelled.
      when n.appointment_id is not null and n.template_key = 'event_cancelled' then ap.status = 'cancelled'
      -- A slot offer is worth sending only while the guest's offer is still open.
      when n.appointment_id is not null and n.template_key = 'slot_offer' then
        ap.status::text = 'offered' and exists (select 1 from app.slot_waitlist w
                                                where w.appointment_id = ap.id and w.status = 'offered' and w.offer_expires_at > now())
      -- An expiry notice is about the booking that lapsed unpaid; it stands while it is still that.
      when n.appointment_id is not null and n.template_key = 'appointment_expired' then
        ap.status = 'cancelled' and ap.cancelled_reason = 'payment_expired'
      -- An appointment message goes only while the booking stands at the time it was queued for,
      -- and a reminder that quiet hours would hold back past the start is dropped, not sent late.
      when n.appointment_id is not null then
        ap.status = 'booked' and ap.starts_at > now()
        and floor(extract(epoch from ap.starts_at))::bigint = (n.vars ->> 'starts_epoch')::bigint
        and (n.channel = 'push' or n.template_key <> 'appointment_reminder'
             or private.quiet_hours_end(now(), l.tz) < ap.starts_at)
      -- Account mail is about something that already happened; it stays worth sending.
      when n.visit_id is null then true
      -- A reply to the guest's own HELP is not an alert: no preference or visit state applies.
      when n.template_key = 'help' or n.template_key like 'reply\_%' then true
      -- The guest turned this alert off after it was queued.
      when not n.template_key = any (private.visit_alert_triggers(n.visit_id)) then false
      -- The call must still stand: not undone, and not superseded by a later call or recall.
      when n.template_key = 'called' then v.status = 'called' and e.undone_by_event_id is null
        and not exists (select 1 from app.visit_events l2
                        where l2.visit_id = v.id and l2.id > n.event_id and l2.type in ('call', 'recall'))
      -- The warning is about the current call: gone once the guest is served, left or was recalled.
      when n.template_key = 'no_show_warning' then v.status = 'called'
        and not exists (select 1 from app.visit_events l2
                        where l2.visit_id = v.id and l2.id > n.event_id and l2.type in ('call', 'recall'))
      -- Removal and service are about what happened; they stand unless the staff undid them.
      when n.template_key = 'removed' then v.status = 'removed' and e.undone_by_event_id is null
      when n.template_key = 'served' then v.status = 'served' and e.undone_by_event_id is null
      when n.template_key in ('almost_up', 'position_changed', 'eta_changed') then v.status = 'waiting'
      else v.status in ('expected', 'waiting', 'called', 'serving')
    end)
    -- WhatsApp: consent, the 24 h window and an approved template are checked again at send time.
    and (n.channel <> 'whatsapp' or coalesce((
           select d.mode is not null
           from private.whatsapp_decision(n.org_id, n.recipient_ref, n.category, coalesce(v.queue_id, ap.queue_id),
                                          coalesce(v.locale, ap.locale, 'en'), n.template_key) d), false))
    from app.notifications n
    left join app.visits v on v.id = n.visit_id
    left join app.appointments ap on ap.id = n.appointment_id
    left join app.locations l on l.id = ap.location_id
    left join app.visit_events e on e.id = n.event_id
    where n.id = p_outbox_id
  ), false);
end $$;
comment on function api.outbox_still_relevant(uuid) is
  'False when sending would be wrong now: the guest turned the alert off, almost_up, position_changed or eta_changed once the guest is no longer waiting, called and no_show_warning after the guest moved on or was called again (called also after an undo), removed and served unless the staff undid them, a joined message for a finished visit, an appointment message whose booking changed (an appointment_expired message instead needs the booking cancelled unpaid) (an event_cancelled message instead needs the booking cancelled), or an unknown id. Account mail and replies to a guest''s own text (help, reply_*) are always still relevant. Implemented in N2 (#68), preferences in 2P-NTF1 (#173), re-notify in 2P-NTF3 (#175), the remaining triggers in 2A-NT1 (#132), events in 2B-A3 (#278), a slot_offer message while its offer is open in 2B-A1 (#276), replies in 3-SMS6 (#355).';

create function private.enqueue_booking_mail() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_service text;
begin
  if new.source <> 'guest' or new.event_id is not null then return null; end if;
  if new.status::text = 'booked' and (tg_op = 'INSERT' or old.status::text in ('pending_payment', 'offered')) then
    select s.name into v_service from app.services s where s.id = new.service_id;
    perform private.enqueue_appointment_notification(new, 'appointment_confirmed', jsonb_build_object('service', v_service));
  elsif tg_op = 'UPDATE' and new.status::text = 'cancelled' and old.status::text = 'pending_payment'
        and new.cancelled_reason = 'payment_expired' then
    select s.name into v_service from app.services s where s.id = new.service_id;
    perform private.enqueue_appointment_notification(new, 'appointment_expired', jsonb_build_object('service', v_service));
  end if;
  return null;
end $$;
comment on function private.enqueue_booking_mail() is
  'After a guest appointment becomes booked (new, paid, or a claimed offer) queues appointment_confirmed; after an unpaid one is cancelled as payment_expired queues appointment_expired. Staff, event and series bookings send nothing.';
revoke all on function private.enqueue_booking_mail() from public, anon, authenticated;
create trigger enqueue_booking_mail after insert or update of status on app.appointments
  for each row execute function private.enqueue_booking_mail();

notify pgrst, 'reload schema';
