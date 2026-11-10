-- 3-CG7 follow-up: marketing broadcasts get their own template key.
--
-- The system `broadcast` templates are transactional (a venue's operational announcement), so a
-- marketing message sent under that key hits category_mismatch. Marketing now uses the trigger
-- `broadcast_marketing`, which (like `broadcast`, kept for existing marketing tests and overrides) a
-- marketing template may bind to; the sender picks the key per send (broadcast for service messages, broadcast_marketing for promotion). Default: the
-- consent rules of 3-CG7 apply unchanged, so a contact without marketing consent is suppressed.

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled',
                     'slot_offer', 'reply_confirmed', 'reply_left', 'reply_commands', 'reply_multiple',
                     'reply_join', 'reply_join_closed', 'usage_alert', 'broadcast_marketing'));

alter table app.notification_templates drop constraint notification_templates_marketing_trigger_check;
alter table app.notification_templates add constraint notification_templates_marketing_trigger_check
  check (category = 'transactional' or trigger in ('broadcast', 'broadcast_marketing'));

insert into app.notification_templates (trigger, channel, category, subject, body) values
  ('broadcast_marketing', 'email', 'marketing', 'A message from the venue',
   E'{{message}}\n\n[Stop these emails: {unsubscribe_url}]'),
  ('broadcast_marketing', 'sms', 'marketing', null, '{{message}} Reply STOP to opt out.');
