-- SMS pumping: +1 is one calling code shared by the US, Canada and about twenty Caribbean and Pacific
-- countries and territories, some of them classic toll-fraud destinations (Dominican Republic,
-- Jamaica, ...). private.phone_countries matched only the prefix `1`, so a number such as
-- +1 876 555 0100 counted as US/CA and passed the country allowlist of an org that allows only US or
-- CA. Teach the longest-prefix match the area codes (calling code + 3-digit NPA = 4 digits, the
-- column's maximum) of every NANP member other than the US and Canada, so those numbers resolve to
-- their own country and stay blocked until an org allowlists that country on purpose.
-- Premium-rate and non-geographic NPAs (900, 976, 5xx personal, 600, 700, ...) resolve to the non-country 'ZZ', which no allowlist offers.
-- Data only: no signature or function body changes.

insert into app.dial_codes (prefix, country_code)
select '1' || npa, c.cc
from (values
  ('AG', array['268']), ('AI', array['264']), ('AS', array['684']), ('BB', array['246']),
  ('BM', array['441']), ('BS', array['242']), ('DM', array['767']), ('DO', array['809', '829', '849']),
  ('GD', array['473']), ('GU', array['671']), ('JM', array['876', '658']), ('KN', array['869']),
  ('KY', array['345']), ('LC', array['758']), ('MP', array['670']), ('MS', array['664']),
  ('PR', array['787', '939']), ('SX', array['721']), ('TC', array['649']), ('TT', array['868']),
  ('VC', array['784']), ('VG', array['284']), ('VI', array['340']), ('ZZ', array['900', '976', '456', '500', '533', '544', '566', '577', '588', '600', '700', '710'])
) c (cc, npas), unnest(c.npas) npa
on conflict do nothing;

-- channel_limits is writable by the org's own owner, so the allowlist itself must be constrained: a
-- (definer: app.dial_codes is readable by no tenant role) code that is not a real destination in app.dial_codes, or the non-country 'ZZ', cannot be listed.
create function private.check_country_allowlist() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from unnest(new.country_allowlist) c
    where c = 'ZZ' or not exists (select 1 from app.dial_codes d where d.country_code = c)
  ) then
    raise exception 'unknown_country' using errcode = '22023';
  end if;
  return new;
end $$;
revoke all on function private.check_country_allowlist() from public;
create trigger check_country_allowlist before insert or update of country_allowlist on app.channel_limits
  for each row execute function private.check_country_allowlist();
