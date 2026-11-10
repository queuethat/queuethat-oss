-- #479 follow-up (security review of #468): anyone receiving a venue's email can stop it. The
-- unsubscribe Edge Function checks a signed link (outbox id + HMAC) and calls
-- api.unsubscribe_outbox; the next PR puts that link in every guest email and its
-- List-Unsubscribe header. Service role only: the signature, not a grant, is what a stranger
-- holds, and only the functions know UNSUBSCRIBE_SECRET. Marketing unsubscribe (#349) builds on it.

create function api.unsubscribe_outbox(p_outbox_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  n app.notifications;
  v_address text;
begin
  select * into n from app.notifications where id = p_outbox_id;
  if not found then
    raise exception 'not_found';
  end if;
  -- Push has its own off switch (the browser), and account mail is the member's own sign-in.
  if n.channel = 'push' or n.visit_id is null then
    return;
  end if;
  v_address := private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id);
  if v_address is null then
    return;
  end if;
  insert into app.suppressions (org_id, channel, value, reason)
  values (n.org_id, n.channel,
          case when n.channel = 'email' then private.canonical_email(v_address) else v_address end, 'stop')
  on conflict (org_id, channel, value) do nothing;
end $$;
comment on function api.unsubscribe_outbox(uuid) is
  'Stops the org that sent outbox row p_outbox_id from messaging its address on that channel again '
  '(and the address''s +tag and Gmail-dot variants), from the next claim on. Idempotent. A push or '
  'account-mail row changes nothing. Raises not_found. Service role only: the unsubscribe Edge '
  'Function calls it after checking the link''s signature.';
revoke all on function api.unsubscribe_outbox(uuid) from public, anon, authenticated;
grant execute on function api.unsubscribe_outbox(uuid) to service_role;
