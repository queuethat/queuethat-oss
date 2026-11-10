-- #1051: ops.waitlist_tick expired waiting entries by the server's date, not the location's local date (I-6).
-- A waiting entry now expires once its wanted day is over in the location's own time zone.
-- redefines ops.waitlist_tick from 20261030172458_slot_waitlist.sql
create or replace function ops.waitlist_tick() returns int
language plpgsql volatile set search_path = '' as $$
declare
  w app.slot_waitlist;
  a app.appointments;
  n int := 0;
begin
  perform private.set_actor('system', null, 'waitlist_tick');
  -- Location lock first, then the row, like claim and leave (the reverse order could deadlock with a claim).
  for w in select x.* from app.slot_waitlist x where x.status = 'offered' and x.offer_expires_at <= now()
           order by x.offer_expires_at
  loop
    perform private.lock_location(w.location_id);
    select x.* into w from app.slot_waitlist x
    where x.id = w.id and x.status = 'offered' and x.offer_expires_at <= now() for update;
    if w.id is null then continue; end if;
    update app.slot_waitlist set status = 'expired' where id = w.id;
    update app.appointments set status = 'cancelled', cancelled_reason = 'offer_expired'
    where id = w.appointment_id and status::text = 'offered' returning * into a;
    if a.id is not null then perform private.release_capacity(a); end if; -- offers it to the next guest
    n := n + 1;
  end loop;
  update app.slot_waitlist x set status = 'expired'
  from app.locations l
  where l.id = x.location_id and x.status = 'waiting' and x.wanted_day < (now() at time zone l.tz)::date;
  return n;
end $$;
comment on function ops.waitlist_tick() is
  'Expires offers past their hold (the slot passes to the next waiting guest) and waiting entries whose day is over '
  'in the location''s time zone. Run every minute by pg_cron; returns how many offers expired.';
