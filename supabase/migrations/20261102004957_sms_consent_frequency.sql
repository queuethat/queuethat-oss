-- Twilio toll-free verification asks the opt-in wording to state message frequency. Publish SMS
-- opt-in copy v2 (English) and the first Spanish text. Published copy is immutable, so v1 stays as
-- it was and every consent that saw it keeps its version and hash. Only the newest version can be
-- granted (api.guest_grant_consent), so a page still showing v1 gets consent_text_mismatch and
-- reloads. No function changes here; WhatsApp copy is unchanged.
insert into app.consent_texts (channel, purpose, locale, version, body) values
  ('sms', 'transactional', 'en', 2,
   '{{business_name}} will text you only about this visit: your place in line and when it is your turn. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Questions: {{support_contact}}.'),
  ('sms', 'transactional', 'es', 1,
   '{{business_name}} te enviará mensajes de texto solo sobre esta visita: tu lugar en la fila y cuándo es tu turno. La frecuencia de mensajes varía. Pueden aplicarse tarifas de mensajes y datos. Responde STOP para cancelar, HELP para ayuda. Preguntas: {{support_contact}}.');
