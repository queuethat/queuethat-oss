-- W4 (#1306, tracker #1267): staff read the waiver record on a visit; managers export it for a date range.
--
-- * The W2 select policy read "staff of the location". Queue-scoped staff (M2c) must only see records of
--   guests on their own lines, as they do for visits and answers, so the policy now goes through
--   private.waiver_subject_visible, which applies private.has_queue_access to the subject's queue.
-- * api.export_waiver_records returns the records of one location for a local-date range and writes an
--   audit_log EXPORT row in the same call, so an export cannot happen unlogged. Managers and above (scope
--   binds staff only, so a manager is never limited to lines). Contact data is not part of the result.
--   Why a function and not a table read: the log write must be impossible to skip (interface rule 5).
-- Retention is untouched: rows still leave only through the response cascade; nothing here assumes the
-- cap, so a longer waiver retention later changes the purge and not this.
-- Alternatives rejected: a CSV Edge Function (pass-through that adds no capability, since the rows are
-- small and RLS-readable); widening the visit_answers reader (answers are replaceable, evidence is not).

create function private.waiver_subject_visible(p_org_id uuid, p_kind text, p_subject_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select private.has_queue_access(p_org_id, case when p_kind = 'visit' then v.queue_id else a.queue_id end, 'staff')
    from (select 1) one
    left join app.visits v on p_kind = 'visit' and v.id = p_subject_id and v.org_id = p_org_id
    left join app.appointments a on p_kind = 'appointment' and a.id = p_subject_id and a.org_id = p_org_id
    where v.id is not null or a.id is not null
  ), false)
$$;
comment on function private.waiver_subject_visible(uuid, text, uuid) is
  'True when the caller may see the visit or appointment a waiver record belongs to: staff at its location '
  'and, for queue-scoped staff, on its line (private.has_queue_access). False for an unknown subject.';
revoke all on function private.waiver_subject_visible(uuid, text, uuid) from public, anon;
grant execute on function private.waiver_subject_visible(uuid, text, uuid) to authenticated, service_role;

drop policy waiver_acceptances_select on app.waiver_acceptances;
create policy waiver_acceptances_select on app.waiver_acceptances for select to authenticated
  using ((select private.waiver_subject_visible(org_id, subject_kind, subject_id)));

create function api.export_waiver_records(p_location_id uuid, p_from date, p_to date) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid;
  v_tz text;
  v_rows jsonb;
  v_count int;
  v_role text;
begin
  select l.org_id, l.tz into v_org, v_tz from app.locations l where l.id = p_location_id;
  if v_org is null or not private.has_role(v_org, p_location_id, 'manager') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'invalid_input';
  end if;

  select coalesce(jsonb_agg(r order by r.accepted_at), '[]'), count(*)::int into v_rows, v_count
  from (
    select w.accepted_at, w.signed_at, w.subject_kind, w.typed_name, w.guardian_name, w.text_hash,
           f.name as form_name, fv.version as form_version,
           (select e ->> 'label' from jsonb_array_elements(fv.fields) e where e ->> 'key' = w.field_key limit 1) as agreement,
           coalesce(v.guest_name, a.guest_name) as guest_name
    from app.waiver_acceptances w
    join app.form_versions fv on fv.id = w.form_version_id
    join app.forms f on f.id = fv.form_id
    left join app.visits v on w.subject_kind = 'visit' and v.id = w.subject_id
    left join app.appointments a on w.subject_kind = 'appointment' and a.id = w.subject_id
    where w.location_id = p_location_id
      and (w.accepted_at at time zone v_tz)::date between p_from and p_to
      and private.waiver_subject_visible(w.org_id, w.subject_kind, w.subject_id)
    order by w.accepted_at
    limit 5000
  ) r;

  select m.role::text into v_role from app.memberships m
  where m.org_id = v_org and m.user_id = (select auth.uid()) order by m.role desc limit 1;
  insert into app.audit_log (org_id, actor, role, action, table_name, row_id, after)
  values (v_org, (select auth.uid()), v_role, 'EXPORT', 'waiver_acceptances', p_location_id::text,
          jsonb_build_object('kind', 'waiver_export', 'from', p_from, 'to', p_to, 'rows', v_count));
  return jsonb_build_object('timezone', v_tz, 'rows', v_rows, 'truncated', v_count >= 5000);
end $$;
comment on function api.export_waiver_records(uuid, date, date) is
  'Waiver acceptance records of a location whose acceptance falls on a local date in [p_from, p_to] (at most '
  '367 days, 5000 rows), oldest first, as {timezone, rows, truncated}. Managers and above at the location '
  '(permission_denied); queue scope binds staff only, so it never limits them. Writes an audit_log EXPORT row every '
  'call. No phone or email. invalid_input for a bad range.';
revoke all on function api.export_waiver_records(uuid, date, date) from public, anon;
grant execute on function api.export_waiver_records(uuid, date, date) to authenticated;
