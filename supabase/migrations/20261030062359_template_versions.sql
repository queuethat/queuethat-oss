-- 2P-NTF5 (#177): template versioning, manager write policy and variable validation.
--
-- Orgs and queues override the system default templates (org_id null, read-only to every org).
-- Each change to an override bumps `version`, records who made it and writes an immutable
-- snapshot, so a sent message (notifications.template_version) can be explained later. Only
-- transactional guest triggers are editable: marketing needs consent that phase 2a does not
-- collect, and account mail (support.*, org.*) is the platform's wording.
--
-- Syntax: new templates use {{variable}}. The system defaults written before this ticket use
-- {variable}; the validator and the shared renderer (2P-NTF6) accept both so nothing is rewritten.

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'support.break_glass', 'org.ownership_transferred'));

alter table app.notification_templates
  add column active boolean not null default true,
  add column updated_by uuid references auth.users (id) on delete set null;
comment on column app.notification_templates.active is
  'An inactive override is skipped by resolution, so the next template in line applies.';

------------------------------------------------------------------------------------------------
-- Snapshots
------------------------------------------------------------------------------------------------

create table app.notification_template_versions (
  id bigint generated always as identity primary key,
  org_id uuid not null references app.organizations (id),
  template_id uuid not null,
  version int not null,
  trigger text not null,
  channel app.notification_channel not null,
  locale text not null,
  queue_id uuid,
  subject text,
  body text not null,
  active boolean not null,
  changed_by uuid,
  changed_at timestamptz not null default now(),
  unique (template_id, version)
);
comment on table app.notification_template_versions is
  'Append-only: one row per version of an org or queue template, written by trigger.';
create index notification_template_versions_org_idx on app.notification_template_versions (org_id, template_id);

create function private.forbid_template_version_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'notification_template_versions is append-only' using errcode = '42501';
end $$;
create trigger append_only before update or delete on app.notification_template_versions
  for each row execute function private.forbid_template_version_change();

revoke insert, update, delete, truncate on app.notification_template_versions from authenticated;
revoke truncate on app.notification_template_versions from service_role;
alter table app.notification_template_versions enable row level security;
create policy notification_template_versions_select on app.notification_template_versions
  for select to authenticated using ((select private.has_role(org_id, null, 'staff')));

------------------------------------------------------------------------------------------------
-- Variables and validation
------------------------------------------------------------------------------------------------

/** The variables an override of p_trigger may use, or null when the trigger is not editable. */
create function private.template_variables(p_trigger text) returns text[]
language sql immutable set search_path = '' as $$
  select case
    when p_trigger = 'broadcast' then array['ticket', 'eta_range']
    when p_trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'removed', 'served') then
      array['guest_first_name', 'ticket', 'queue_name', 'location_name', 'counter', 'eta_range',
            'status_link', 'appointment_time', 'business_phone', 'unsubscribe_url']
  end
$$;
comment on function private.template_variables(text) is
  'Allowlist of {{variables}} for a guest trigger (broadcast is narrower: it is free text sent to '
  'a whole queue). Null for account triggers, which orgs cannot override.';

/** Variable names used in p_text, in either {{name}} or legacy {name} form. */
create function private.template_used_variables(p_text text) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct v), '{}')
  from (
    select m[1] as v from regexp_matches(coalesce(p_text, ''), '\{\{\s*([A-Za-z0-9_.]+)\s*\}\}', 'g') m
    union all
    -- Every {name} in the raw text, so `{{x {name}}}` cannot hide one from the check; the
    -- dispatcher substitutes legacy {name} wherever it finds it.
    select m[1] from regexp_matches(coalesce(p_text, ''), '\{([A-Za-z0-9_.]+)\}', 'g') m
  ) s
$$;

/** True when p_text has a {{ that is not a well-formed {{name}} placeholder. */
create function private.template_malformed(p_text text) returns boolean
language sql immutable set search_path = '' as $$
  select regexp_replace(coalesce(p_text, ''), '\{\{\s*[A-Za-z0-9_.]+\s*\}\}', '', 'g') like '%{{%'
$$;

create function private.validate_template() returns trigger
language plpgsql set search_path = '' as $$
declare
  allowed text[] := private.template_variables(new.trigger);
  unknown text;
begin
  if new.org_id is null then
    return new; -- system defaults are written by migrations
  end if;
  if new.category <> 'transactional' then
    raise exception 'invalid_category';
  end if;
  if allowed is null then
    raise exception 'invalid_trigger';
  end if;
  if private.template_malformed(new.body) or private.template_malformed(new.subject) then
    raise exception 'unknown_variable' using detail = 'malformed placeholder';
  end if;
  select u into unknown
  from unnest(private.template_used_variables(new.body) || private.template_used_variables(new.subject)) u
  where u <> all (allowed) order by u limit 1;
  if unknown is not null then
    raise exception 'unknown_variable' using detail = unknown;
  end if;
  -- The version is the server's to keep: members cannot set or rewind it, so a snapshot is never
  -- skipped and notifications.template_version always names one text.
  if tg_op = 'INSERT' then
    if (select auth.uid()) is not null then
      new.version := 1;
    end if;
  else
    if new.id <> old.id then
      raise exception 'immutable_column' using errcode = '42501';
    end if;
    new.version := old.version + case when (new.body, new.subject, new.active, new.trigger, new.channel,
                                            new.locale, new.queue_id)
      is distinct from (old.body, old.subject, old.active, old.trigger, old.channel, old.locale, old.queue_id)
      then 1 else 0 end;
  end if;
  new.updated_by := (select auth.uid());
  return new;
end $$;
comment on function private.validate_template() is
  'BEFORE INSERT/UPDATE on app.notification_templates for org and queue overrides: transactional '
  'guest triggers only (invalid_category, invalid_trigger), every {{variable}} on the trigger''s '
  'allowlist (unknown_variable, the name in the error detail), version +1 on a content change.';
create trigger validate_template before insert or update on app.notification_templates
  for each row execute function private.validate_template();

create function private.snapshot_template() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.org_id is not null then
    insert into app.notification_template_versions (org_id, template_id, version, trigger, channel,
                                                    locale, queue_id, subject, body, active, changed_by)
    values (new.org_id, new.id, new.version, new.trigger, new.channel, new.locale, new.queue_id,
            new.subject, new.body, new.active, new.updated_by);
  end if;
  return null;
end $$;
comment on function private.snapshot_template() is
  'AFTER INSERT/UPDATE on app.notification_templates: appends the override''s new version.';
create trigger snapshot_template_insert after insert on app.notification_templates
  for each row execute function private.snapshot_template();
create trigger snapshot_template_update after update on app.notification_templates
  for each row when (old.version is distinct from new.version) execute function private.snapshot_template();

------------------------------------------------------------------------------------------------
-- Who writes
------------------------------------------------------------------------------------------------

drop policy notification_templates_insert on app.notification_templates;
drop policy notification_templates_update on app.notification_templates;
drop policy notification_templates_delete on app.notification_templates;
create policy notification_templates_insert on app.notification_templates for insert to authenticated
  with check (org_id is not null and (select private.has_role(org_id, null, 'manager')));
create policy notification_templates_update on app.notification_templates for update to authenticated
  using (org_id is not null and (select private.has_role(org_id, null, 'manager')))
  with check (org_id is not null and (select private.has_role(org_id, null, 'manager')));
create policy notification_templates_delete on app.notification_templates for delete to authenticated
  using (org_id is not null and (select private.has_role(org_id, null, 'manager')));

------------------------------------------------------------------------------------------------
-- Resolution order
------------------------------------------------------------------------------------------------

-- redefines private.resolve_template from 20261025002000_enqueue_notifications.sql
create or replace function private.resolve_template(
  p_org_id uuid,
  p_queue_id uuid,
  p_trigger text,
  p_channel app.notification_channel,
  p_locale text
) returns setof app.notification_templates
language sql stable set search_path = '' as $$
  select t.*
  from app.notification_templates t
  left join app.organizations o on o.id = p_org_id
  where t.trigger = p_trigger and t.channel = p_channel and t.active
    and (t.org_id is null or t.org_id = p_org_id)
    and (t.queue_id is null or t.queue_id = p_queue_id)
    and t.locale in (p_locale, o.default_locale, 'en')
  order by case
      when t.queue_id is not null and t.locale = p_locale then 1
      when t.org_id is not null and t.queue_id is null and t.locale = p_locale then 2
      when t.org_id is not null and t.locale = o.default_locale then 3
      when t.org_id is null and t.locale = p_locale then 4
      else 5
    end,
    t.queue_id is not null desc, t.org_id is not null desc, t.id
  limit 1
$$;
comment on function private.resolve_template(uuid, uuid, text, app.notification_channel, text) is
  'The template a message uses, first match of: queue override in the guest''s locale, org '
  'override in the guest''s locale, org or queue override in the org''s default locale, system '
  'default in the guest''s locale, system default in English. Inactive overrides are skipped. No '
  'row means the channel is not offered for that trigger.';

revoke all on function private.validate_template(), private.snapshot_template(),
  private.forbid_template_version_change() from public, anon, authenticated;
-- Pure helpers the validation trigger calls as the editing member; they read no table.
revoke all on function private.template_variables(text), private.template_used_variables(text), private.template_malformed(text)
  from public, anon;
grant execute on function private.template_variables(text), private.template_used_variables(text),
  private.template_malformed(text) to authenticated, service_role;
