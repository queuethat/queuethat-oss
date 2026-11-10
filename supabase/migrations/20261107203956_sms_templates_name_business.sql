-- Every guest SMS opens with the business that sent it. A guest who gets "QueueThat: It's your turn"
-- from a shared toll-free number cannot tell which shop wrote, which drives STOPs and spam reports,
-- and the Twilio toll-free reviewer compares the form's samples with the texts actually sent. The
-- outbox fills {location_name} from the visit's location when a row is claimed (api.claim_outbox),
-- so the defaults need no new variable. Each stays under one 160-character segment with a typical
-- name. Bumping the version keeps notifications.template_version naming the text that was sent.
-- reply_join gains the STOP line every promised text carries.
update app.notification_templates
set body = case
      when trigger = 'almost_up' then
        '{location_name}: You''re almost up ({ticket}). Please head back now. Reply STOP to opt out.'
      when trigger = 'called' then
        '{location_name}: It''s your turn: {ticket}. [Please go to {counter}.] Reply STOP to opt out.'
      when trigger = 'reply_verify' then
        '{location_name}: your code is {code}. It expires in 10 minutes. Reply STOP to opt out.'
      when trigger = 'reply_join' then
        '{location_name}: You''re in line at {queue_name}, ticket {ticket}, number {position}. Reply L to leave or STOP to opt out.'
    end,
    version = version + 1
where org_id is null and queue_id is null and channel = 'sms' and locale = 'en'
  and trigger in ('almost_up', 'called', 'reply_verify', 'reply_join');
