-- #583: the kick-dispatcher job only queues an HTTP request through pg_net, so pg_cron reports
-- it as succeeded even when the dispatcher answers 401 (a rotated or mistyped dispatcher_key)
-- or 500, and the health page stays green while no mail goes out. The answer arrives later in
-- net._http_response, so a second job reads it back: it fails when the newest response from the
-- last 10 minutes was not a 2xx, and passes again as soon as a kick succeeds. It cannot be folded into
-- kick_dispatcher_if_due: raising would roll back the request that function has just queued.
-- Nothing in this repo uses pg_net but the dispatcher kick. Kicks happen every 15 s while mail is
-- due, so a real failure keeps the check red; on an idle system it clears within 10 minutes.

create function ops.check_dispatcher_response() returns void
language plpgsql volatile set search_path = '' as $$
declare
  r record;
begin
  select status_code, timed_out, error_msg into r
  from net._http_response
  where created > now() - interval '10 minutes'
  order by id desc
  limit 1;
  if found and (r.timed_out or r.status_code is null or r.status_code not between 200 and 299) then
    raise exception 'dispatcher answered %', coalesce(r.status_code::text, left(r.error_msg, 200), 'nothing');
  end if;
end $$;
comment on function ops.check_dispatcher_response() is
  'Fails (so the pg_cron job and the health page show it) when the dispatcher''s newest response '
  'from the last 10 minutes was not a 2xx: the HTTP status, a timeout or a connection error. Passes when '
  'there is no recent response or the newest one succeeded. Run every minute by pg_cron.';
revoke all on function ops.check_dispatcher_response() from public, anon, authenticated;

select cron.schedule('check-dispatcher', '* * * * *', 'select ops.check_dispatcher_response()');
