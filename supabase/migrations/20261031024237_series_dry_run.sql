-- 4-APT2 (#386): staff see a series' conflicts before they confirm. Appends a defaulted p_dry_run to
-- api.create_appointment_series instead of adding a preview RPC (interface rule 1). A parameter cannot be
-- added in place and nothing calls the old 12-argument form yet, so it is dropped and recreated.
-- redefines api.create_appointment_series from 20261031022528_appointment_series.sql
drop function api.create_appointment_series(uuid, uuid, date, time, int, int, date, uuid, text, text, text, uuid);

create function api.create_appointment_series(
  p_location_id uuid, p_service_id uuid, p_first_date date, p_local_time time, p_interval_weeks int,
  p_count int, p_until date, p_staff_user_id uuid, p_name text, p_phone_e164 text, p_email text,
  p_idempotency_key uuid, p_dry_run boolean default false
) returns api.appointment_series_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  l app.locations;
  uid uuid := (select auth.uid());
  s_id uuid;
  v_count int;
  v_date date;
  v_booked date[] := '{}';
  v_conflicts jsonb := '[]';
  v_guest uuid;
  r record;
  a app.appointments;
begin
  select * into l from app.locations where id = p_location_id;
  if l.id is null or not (select private.has_role(l.org_id, l.id, 'staff')) then raise exception 'not_found'; end if;
  if p_idempotency_key is null or p_first_date is null or p_local_time is null
     or p_interval_weeks is null or p_interval_weeks not between 1 and 8
     or (p_count is null and p_until is null) or p_count < 1 or p_until < p_first_date then
    raise exception 'invalid_input';
  end if;
  perform private.lock_location(l.id);

  select id into s_id from app.appointment_series where location_id = l.id and idempotency_key = p_idempotency_key;
  if s_id is not null then -- a repeat returns the first answer and books nothing
    select coalesce(array_agg(x.local_date order by x.local_date), '{}') into v_booked
    from app.appointments x where x.series_id = s_id;
    select conflict_dates into v_conflicts from app.appointment_series where id = s_id;
    return row(s_id, v_booked, v_conflicts)::api.appointment_series_result;
  end if;

  begin -- a dry run raises at the end of this block, which rolls back everything inside it
  v_count := least(coalesce(p_count, 26), 26);
  s_id := gen_random_uuid();
  insert into app.appointment_series (id, org_id, location_id, service_id, rule, created_by, idempotency_key)
  values (s_id, l.org_id, l.id, p_service_id,
          jsonb_strip_nulls(jsonb_build_object('freq', 'weekly', 'interval', p_interval_weeks,
            'weekday', extract(dow from p_first_date)::int, 'local_time', p_local_time, 'first_date', p_first_date,
            'count', p_count, 'until', p_until)), uid, p_idempotency_key);

  for i in 0 .. v_count - 1 loop
    v_date := p_first_date + i * p_interval_weeks * 7;
    exit when p_until is not null and v_date > p_until;
    begin
      select * into r from private.book_core(l.id, p_service_id, (v_date + p_local_time) at time zone l.tz,
        p_staff_user_id, p_name, p_phone_e164, p_email, 1, null, md5(p_idempotency_key::text || ':' || i)::uuid,
        'staff', 'staff', uid, false);
      a := r.appointment;
      -- the series link is set after the insert, so the guard trigger needs the actor context again
      perform private.set_actor('staff', uid, null, null, jsonb_build_object('series_id', s_id));
      update app.appointments set series_id = s_id where id = a.id;
      v_guest := coalesce(v_guest, a.guest_id);
      v_booked := v_booked || v_date;
    exception when raise_exception then
      if sqlerrm not in ('slot_full', 'slot_unavailable') then raise; end if;
      v_conflicts := v_conflicts || jsonb_build_object('date', v_date, 'code', sqlerrm);
    end;
  end loop;

  if cardinality(v_booked) = 0 then -- nothing to keep: no empty series
    delete from app.appointment_series where id = s_id;
    s_id := null;
  else
    update app.appointment_series set guest_id = v_guest, conflict_dates = v_conflicts where id = s_id;
  end if;
  if coalesce(p_dry_run, false) then raise exception 'dry_run'; end if;
  exception when raise_exception then
    if sqlerrm <> 'dry_run' then raise; end if;
    s_id := null;
  end;
  return row(s_id, v_booked, v_conflicts)::api.appointment_series_result;
end $$;
comment on function api.create_appointment_series(uuid, uuid, date, time, int, int, date, uuid, text, text, text, uuid, boolean) is
  'Staff books a weekly (every p_interval_weeks, 1..8) series starting p_first_date at the location-local '
  'p_local_time, for p_count occurrences and/or until p_until, at most 26. Each date is checked like a single '
  'booking; full or invalid dates are returned in conflicts as {date, code} and the rest are booked. No '
  'capacity override. Idempotent per (location, key): a repeat returns the first answer. Returns a null '
  'series_id when no date could be booked. With p_dry_run the same answer is computed and nothing is kept (series_id is null), so staff see the conflicts before they confirm. Raises not_found (unknown location, or no staff role) and invalid_input.';
revoke all on function api.create_appointment_series(uuid, uuid, date, time, int, int, date, uuid, text, text, text, uuid, boolean) from public, anon;
grant execute on function api.create_appointment_series(uuid, uuid, date, time, int, int, date, uuid, text, text, text, uuid, boolean) to authenticated, service_role;

