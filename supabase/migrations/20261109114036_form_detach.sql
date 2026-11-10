-- F6 (#1282): api.detach_form, plus the minimum widening of private.validate_form_fields so the
-- plain editor can round-trip queue default forms.
--
-- Alternative considered (rule 7): a delete_form_target(target_id) per row. Rejected: attach is
-- bulk and all-or-nothing, so detach mirrors it, and undo (I-9) is attach_form with the same ids.
-- Not a pass-through: it owns the rule that a queue default form is managed by the intake sync
-- and is never detached by hand, and that a detach is idempotent.

-- redefines private.validate_form_fields from 20261109095858_form_admin_rpcs.sql
-- Change: also accepts the legacy field types (text, select, checkbox) and the `position` key that
-- the guest engine (F2) reads today. A separate ticket unifies the vocabularies and replaces this.
create or replace function private.validate_form_fields(p_fields jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare
  f jsonb;
  t text;
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'array' or jsonb_array_length(p_fields) > 20 then
    raise exception 'invalid_input' using detail = 'fields';
  end if;
  if (select count(distinct e ->> 'key') from jsonb_array_elements(p_fields) e) <> jsonb_array_length(p_fields) then
    raise exception 'invalid_input' using detail = 'duplicate key';
  end if;
  for f in select e from jsonb_array_elements(p_fields) e loop
    if jsonb_typeof(f) <> 'object'
       or exists (select 1 from jsonb_object_keys(f) k
                  where k not in ('key', 'label', 'help', 'type', 'options', 'required', 'visibility', 'sensitivity', 'position')) then
      raise exception 'invalid_input' using detail = 'field shape';
    end if;
    if jsonb_typeof(f -> 'key') is distinct from 'string' or (f ->> 'key') !~ '^[a-z][a-z0-9_]{0,39}$' then
      raise exception 'invalid_input' using detail = 'key';
    end if;
    if jsonb_typeof(f -> 'label') is distinct from 'string' or length(btrim(f ->> 'label')) not between 1 and 120 then
      raise exception 'invalid_input' using detail = 'label';
    end if;
    if f ? 'help' and (jsonb_typeof(f -> 'help') <> 'string' or length(f ->> 'help') > 300) then
      raise exception 'invalid_input' using detail = 'help';
    end if;
    t := f ->> 'type';
    if jsonb_typeof(f -> 'type') is distinct from 'string' or t not in (
         'short_text', 'long_text', 'single_choice', 'multi_choice', 'yes_no', 'number', 'date',
         'phone', 'email', 'heading', 'marketing_consent', 'text', 'select', 'checkbox') then
      raise exception 'invalid_input' using detail = 'type';
    end if;
    if (t in ('single_choice', 'multi_choice', 'select')) <> (f ? 'options') then
      raise exception 'invalid_input' using detail = 'options';
    end if;
    if f ? 'options' and (
         jsonb_typeof(f -> 'options') <> 'array'
         or jsonb_array_length(f -> 'options') not between 1 and 50
         or exists (select 1 from jsonb_array_elements(f -> 'options') o
                    where jsonb_typeof(o) <> 'string' or length(btrim(o #>> '{}')) not between 1 and 80)
         or (select count(distinct o) from jsonb_array_elements(f -> 'options') o) <> jsonb_array_length(f -> 'options')) then
      raise exception 'invalid_input' using detail = 'options';
    end if;
    if f ? 'required' and (jsonb_typeof(f -> 'required') <> 'boolean'
                           or ((f ->> 'required')::boolean and t in ('heading', 'marketing_consent'))) then
      raise exception 'invalid_input' using detail = 'required';
    end if;
    if f ? 'visibility' and not coalesce((f ->> 'visibility') = any (array['guest', 'staff_only']), false) then
      raise exception 'invalid_input' using detail = 'visibility';
    end if;
    if f ? 'sensitivity' and not coalesce((f ->> 'sensitivity') = any (array['normal', 'personal', 'sensitive']), false) then
      raise exception 'invalid_input' using detail = 'sensitivity';
    end if;
  end loop;
end $$;

create function api.detach_form(
  p_org_id uuid, p_form_id uuid, p_target_ids uuid[], p_channel text default null
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_form app.forms;
  v_n integer;
begin
  select * into v_form from app.forms f where f.id = p_form_id and f.org_id = p_org_id;
  if not found or not private.has_role(p_org_id, v_form.location_id, 'manager') then
    raise exception 'not_found';
  end if;
  if (p_channel is not null and p_channel not in ('any', 'walk_in', 'booking'))
     or cardinality(p_target_ids) > 100 or exists (select 1 from unnest(p_target_ids) x where x is null) then
    raise exception 'invalid_input';
  end if;
  if v_form.is_queue_default then
    raise exception 'invalid_input' using detail = 'queue default';
  end if;
  delete from app.form_targets t
  where t.form_id = v_form.id and (p_channel is null or t.channel = p_channel)
    and coalesce(t.queue_id, t.service_id) = any (p_target_ids);
  get diagnostics v_n = row_count;
  return v_n;
end $$;
comment on function api.detach_form(uuid, uuid, uuid[], text) is
  'Stops showing a library form on the given queues and services (p_channel any, walk_in or booking; '
  'null = every channel). Targets not showing this form are ignored, so repeating a detach is a no-op. '
  'Returns how many attachments were removed. Undo is api.attach_form with the same ids and channel. '
  'Callable by managers and above of the form''s location; raises not_found for a foreign or missing '
  'form, invalid_input for an unknown channel, a null id, more than 100 ids, or a queue default form.';
revoke all on function api.detach_form(uuid, uuid, uuid[], text) from public, anon;
grant execute on function api.detach_form(uuid, uuid, uuid[], text) to authenticated, service_role;

notify pgrst, 'reload schema';
