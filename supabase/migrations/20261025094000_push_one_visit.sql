-- #507 (security review of N5 #504, LOW): one browser, one visit. A browser has a single push
-- subscription per origin, so on a shared phone the previous guest's still-active visit kept the
-- endpoint and its alerts kept arriving for the next person. Registering an endpoint now takes it
-- off every other visit that holds the same subscription (endpoint and keys), in any org. A shared
-- phone re-sends its one subscription unchanged, so the keys match; anyone who only knows an
-- endpoint can't produce the keys.
--
-- Security review of #510: org admins could SELECT whole subscription rows, so a venue learned the
-- endpoint (and keys) of every browser that opted in there. Only the non-secret columns stay
-- readable now; nothing in the app reads the rest.

revoke select on app.push_subscriptions from authenticated;
grant select (id, org_id, visit_id, created_at) on app.push_subscriptions to authenticated;

-- The move below looks rows up by endpoint.
create index push_subscriptions_endpoint_idx on app.push_subscriptions (endpoint);

------------------------------------------------------------------------------------------------
-- redefines api.guest_register_push from 20261025004300_push.sql
-- guest_register_push: the 20261025004300_push.sql body, plus deleting the endpoint from other
-- visits before the insert
------------------------------------------------------------------------------------------------

create or replace function api.guest_register_push(
  p_token text, p_endpoint text, p_p256dh text, p_auth text
) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  v_p256dh text := rtrim(p_p256dh, '=');
  v_auth text := rtrim(p_auth, '=');
begin
  v := private.visit_by_token(p_token);
  -- p256dh is a 65-byte P-256 point and auth a 16-byte secret, both base64url.
  if not private.is_push_endpoint(p_endpoint)
     or v_p256dh !~ '^[A-Za-z0-9_-]{87}$' or v_auth !~ '^[A-Za-z0-9_-]{22}$'
     or v_p256dh is null or v_auth is null then
    raise exception 'invalid_input';
  end if;

  -- One browser, one visit. Matching the keys too means only the browser itself can move its
  -- subscription. Queued pushes for the old visit then find no recipient and end as gone
  -- (recipient_deleted) in the dispatcher.
  delete from app.push_subscriptions s
  where s.endpoint = p_endpoint and s.p256dh = v_p256dh and s.auth = v_auth and s.visit_id <> v.id;

  insert into app.push_subscriptions (org_id, visit_id, endpoint, p256dh, auth)
  values (v.org_id, v.id, p_endpoint, v_p256dh, v_auth)
  on conflict (visit_id, endpoint) do nothing;
  if found then
    -- One guest has a few browsers at most; keep the newest five so a token can't grow the table.
    delete from app.push_subscriptions s
    where s.visit_id = v.id and s.id not in (
      select k.id from app.push_subscriptions k where k.visit_id = v.id
      order by k.created_at desc, k.id desc limit 5);
  end if;
end $$;
comment on function api.guest_register_push(text, text, text, text) is
  'Stores a Web Push subscription for the token''s visit; pushes for its called and almost-up '
  'events go to it until the push service reports it gone. One browser, one visit: the same '
  'subscription (endpoint and keys) is removed from every other visit (any org), so a shared '
  'phone stops getting the previous guest''s alerts; an endpoint with other keys leaves them '
  'alone. Nothing about other visits is returned. Repeating it with the same endpoint '
  'changes nothing; a visit keeps its five newest subscriptions. Raises not_found as '
  'get_visit_status does, invalid_input for an endpoint that is not https on a known push '
  'service (FCM, Mozilla, Apple, WNS) or keys that are not base64url of the right length. '
  'Implemented in N4 (#70).';
