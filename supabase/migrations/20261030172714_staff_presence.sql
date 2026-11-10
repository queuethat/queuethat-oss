-- 2B-S1 (#271): staff presence (S-15). Staff mark themselves available, on break or away; the ETA
-- counts only available staff once anyone at the location has reported presence recently.
-- redefines private.eta_servers from 20261030171927_staff_shifts.sql
-- redefines api.set_my_presence from 20261030162713_api_contracts_2b.sql

create table app.staff_presence (
  org_id uuid not null,
  location_id uuid not null,
  user_id uuid not null,
  status text not null check (status in ('available', 'break', 'away')),
  counter_id uuid,
  since timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, location_id),
  foreign key (org_id, location_id) references app.locations (org_id, id) on delete cascade,
  foreign key (org_id, location_id, counter_id) references app.counters (org_id, location_id, id),
  foreign key (org_id, user_id) references app.memberships (org_id, user_id) on delete cascade
);
create index staff_presence_location_idx on app.staff_presence (location_id, updated_at);
create trigger forbid_org_change before update on app.staff_presence
  for each row execute function private.forbid_org_change();

alter table app.staff_presence enable row level security;
-- Written only by api.set_my_presence.
create policy staff_presence_select on app.staff_presence for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')));
revoke all on app.staff_presence from public, anon, authenticated;
grant select on app.staff_presence to authenticated;

create or replace function api.set_my_presence(p_location_id uuid, p_status text, p_counter_id uuid, p_idempotency_key uuid)
returns api.presence_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  org uuid;
  claim record;
  blocked text;
  r app.staff_presence;
  result api.presence_row;
  qid uuid;
begin
  select l.org_id into org from app.locations l where l.id = p_location_id;
  if uid is null or org is null or not private.has_role(org, p_location_id, 'staff') then
    raise exception 'not_found';
  end if;
  blocked := private.write_blocked_reason(org, 'staff', uid);
  if blocked is not null then
    raise exception '%', blocked using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_status is null or p_status not in ('available', 'break', 'away')
     or (p_counter_id is not null and not exists (
           select 1 from app.counters c where c.id = p_counter_id and c.location_id = p_location_id and c.archived_at is null)) then
    raise exception 'invalid_input';
  end if;

  select * into claim from private.claim_idempotent(org, 'set_my_presence', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.presence_row, claim.response);
  end if;

  insert into app.staff_presence as sp (org_id, location_id, user_id, status, counter_id)
  values (org, p_location_id, uid, p_status, p_counter_id)
  on conflict (user_id, location_id) do update
    set since = case when sp.status = excluded.status and sp.updated_at > now() - interval '12 hours'
                     then sp.since else now() end,
        status = excluded.status, counter_id = excluded.counter_id, updated_at = now()
  returning * into r;

  -- The estimate changed: tell every open queue of the location.
  for qid in select q.id from app.queues q where q.location_id = p_location_id and q.archived_at is null loop
    perform private.bump_queue_version(qid);
  end loop;

  result := (r.user_id, r.location_id, r.status, r.counter_id, r.since)::api.presence_row;
  perform private.save_idempotent('set_my_presence', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.set_my_presence(uuid, text, uuid, uuid) is
  'Sets the caller''s presence (available, break, away) at a location, optionally at a counter of '
  'that location; since moves only when the status changes. The ETA counts available staff once '
  'anyone at the location has reported within 12 hours; presence older than 12 hours counts as '
  'away. Staff of the location; bumps the version of the location''s queues. Raises not_found '
  '(unknown or foreign location), invalid_input (bad status, a counter of another location, no '
  'key). Idempotent per key. Implemented by 2B-S1 (#271).';

create or replace function private.eta_servers(p_queue_id uuid) returns int
language sql stable set search_path = '' as $$
  select case
    -- Anyone reporting presence in the last 12 hours switches the location to presence counting.
    when exists (select 1 from app.staff_presence p
                 where p.location_id = q.location_id and p.updated_at > now() - interval '12 hours')
      then (select count(*)::int from app.staff_presence p
            where p.location_id = q.location_id and p.status = 'available'
              and p.updated_at > now() - interval '12 hours')
    when q.use_shift_schedule and private.scheduled_servers(q.location_id) > 0
      then private.scheduled_servers(q.location_id)
    else q.servers_on_duty
  end
  from app.queues q where q.id = p_queue_id
$$;
comment on function private.eta_servers(uuid) is
  'How many servers the ETA divides by. Order: available staff when anyone at the location has '
  'reported presence in the last 12 hours (zero = unstaffed), else staff on shift now when the '
  'queue uses the shift schedule and anyone is scheduled, else servers_on_duty. Null for an '
  'unknown queue.';
