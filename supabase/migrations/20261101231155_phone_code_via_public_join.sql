-- #986: requesting a code costs real money, so it goes through the public-join Edge Function (CAPTCHA and
-- per-IP limit) and anon can no longer call api.guest_request_phone_code directly. Verifying a code stays
-- anonymous: it sends nothing and is limited per visit, device and network in the database.
revoke execute on function api.guest_request_phone_code(text) from anon, authenticated;
grant execute on function api.guest_request_phone_code(text) to service_role;
comment on function api.guest_request_phone_code(text) is
  'Service role only (public-join, after its CAPTCHA and per-IP limit). Sends a 6-digit code to the phone on the token''s open visit and '
  'returns state sent with the earliest resend time, or verified when the number already is. Needs the visit''s sms consent (consent_required) '
  'and texts switched on for the business (sms_unavailable). A number the business holds or has opted out gets the same answer with no '
  'message. Unknown or ended-visit tokens raise not_found; GET raises invalid_input. rate_limited after 6 requests per visit, 12 per device, '
  '60 per network (or 60 for all callers with no network address) an hour, 60 per business an hour, 5 per number a day, or 3 sends in an hour; '
  'a repeat within 30 seconds returns the same state without sending. The code lives 10 minutes and is stored only as an HMAC.';
notify pgrst, 'reload schema';
