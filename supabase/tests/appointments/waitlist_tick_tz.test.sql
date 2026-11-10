-- #1051: ops.waitlist_tick expires waiting entries at the location's local midnight (I-6), not UTC midnight.
-- The clock cannot be frozen inside a transaction, so the days are derived from each zone's own today. With
-- zones 26 h apart, at least one of them always has a local date different from the UTC date, so a UTC-date
-- implementation fails whatever time the suite runs.
begin;
\ir ../helpers/_setup.psql
select plan(8);
select tests.create_world();

create function pg_temp.entry(p_name text, p_day date) returns void language sql as $$
  insert into app.slot_waitlist (org_id, location_id, service_id, wanted_day, name, guest_email, token_hash, idempotency_key)
  values (tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), p_day, p_name, p_name || '@example.com',
          sha256(convert_to(p_name, 'utf8')), gen_random_uuid());
$$;
-- Ahead of UTC (UTC+14): its local today is the UTC date or the day after it.
update app.locations set tz = 'Pacific/Kiritimati' where id = tests.id('loc_a');
select pg_temp.entry('ahead_over', (now() at time zone 'Pacific/Kiritimati')::date - 1);
select pg_temp.entry('ahead_today', (now() at time zone 'Pacific/Kiritimati')::date);
select ops.waitlist_tick();
select is((select count(*)::int from app.slot_waitlist where status = 'expired'), 1, 'ahead of UTC: only the entry whose local day is over expired');
select is((select count(*)::int from app.slot_waitlist where status = 'waiting' and wanted_day = (now() at time zone 'Pacific/Kiritimati')::date), 1,
  'ahead of UTC: the entry for the local today still waits, though UTC may already be a day behind it');

-- Behind UTC (UTC-12): its local today is the UTC date or the day before it.
delete from app.slot_waitlist;
update app.locations set tz = 'Etc/GMT+12' where id = tests.id('loc_a');
select pg_temp.entry('behind_over', (now() at time zone 'Etc/GMT+12')::date - 1);
select pg_temp.entry('behind_today', (now() at time zone 'Etc/GMT+12')::date);
select ops.waitlist_tick();
select is((select count(*)::int from app.slot_waitlist where status = 'expired'), 1, 'behind UTC: only the entry whose local day is over expired');
select is((select count(*)::int from app.slot_waitlist where status = 'waiting' and wanted_day = (now() at time zone 'Etc/GMT+12')::date), 1,
  'behind UTC: the entry for the local today still waits');

-- A location whose local midnight just passed expires yesterday's entry even when UTC is still on the same day
delete from app.slot_waitlist;
update app.locations set tz = 'Pacific/Kiritimati' where id = tests.id('loc_a');
select pg_temp.entry('future_day', (now() at time zone 'Pacific/Kiritimati')::date + 3);
select pg_temp.entry('yesterday_local', (now() at time zone 'Pacific/Kiritimati')::date - 1);
select is(ops.waitlist_tick(), 0, 'the tick returns only the expired offers (none here)');
select is((select status::text from app.slot_waitlist where wanted_day = (now() at time zone 'Pacific/Kiritimati')::date - 1), 'expired', 'yesterday (local) is expired');
select is((select status::text from app.slot_waitlist where wanted_day = (now() at time zone 'Pacific/Kiritimati')::date + 3), 'waiting', 'a future day still waits');
select is(ops.waitlist_tick(), 0, 'running the tick again is a no-op');

select * from finish();
rollback;
