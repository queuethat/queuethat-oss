-- #1135: internal support notes and tags per tenant (epic #1128).
--
--   * Platform-only. app.platform_org_notes has org_id (it is about a tenant) but no tenant role
--     can read or write it: RLS lets only support or operator with aal2 select, and every write
--     goes through api.platform_add_note. Tenants never see it, and org detail, the tenant
--     audit_log and exports do not include it.
--   * Append-only with soft edit history: an edit inserts the next version of the same note
--     (root_id, version). Nothing is updated or deleted, except when the org itself is purged.
--   * The org's tags are the union of the tags on the current version of each of its notes.
--   * platform_audit records who added or edited a note and its tags, never the body, which is
--     free text and may be pasted from a support email.

create table app.platform_org_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  -- The first version's id: every version of one note shares it. Version 1 has root_id = id.
  root_id uuid not null,
  version int not null check (version >= 1),
  author_id uuid references auth.users (id) on delete set null,
  body text not null check (length(body) between 1 and 4000 and body = btrim(body)),
  tags text[] not null default '{}' check (cardinality(tags) <= 10),
  idempotency_key uuid,
  created_at timestamptz not null default now(),
  check ((version = 1) = (root_id = id)),
  unique (root_id, version),
  unique (author_id, idempotency_key)
);
create index platform_org_notes_org_idx on app.platform_org_notes (org_id, root_id, version desc);

create function private.forbid_platform_note_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- A purge or cascade removes the notes after the org row is gone; nothing else may.
  if tg_op = 'DELETE' and not exists (select 1 from app.organizations o where o.id = old.org_id) then
    return old;
  end if;
  raise exception 'platform_org_notes is append-only' using errcode = '42501';
end $$;
create trigger forbid_change before update or delete on app.platform_org_notes
  for each row execute function private.forbid_platform_note_change();
create trigger forbid_truncate before truncate on app.platform_org_notes
  for each statement execute function private.forbid_platform_note_change();

------------------------------------------------------------------------------------------------
-- Privileges and row-level security
------------------------------------------------------------------------------------------------

revoke all on app.platform_org_notes from anon, authenticated, service_role;
grant select on app.platform_org_notes to authenticated;
alter table app.platform_org_notes enable row level security;
create policy platform_org_notes_select on app.platform_org_notes for select to authenticated
  using ((select private.is_platform('support')));

------------------------------------------------------------------------------------------------
-- Tags
------------------------------------------------------------------------------------------------

/** Tags that put a tenant in front of the attention queue. The one owner of that list. */
create function private.note_attention_tags() returns text[]
language sql immutable set search_path = '' as $$ select array['churn-risk', 'billing-issue'] $$;

/**
 * Lower-cases, trims, de-duplicates and sorts p_tags; null is no tags. Raises invalid_input for
 * a null element, one that is not 1-30 letters, digits or hyphens starting with a letter or
 * digit, or more than 10 distinct tags.
 */
create function private.normalize_note_tags(p_tags text[]) returns text[]
language plpgsql immutable set search_path = '' as $$
declare
  v text[];
begin
  if exists (select 1 from unnest(coalesce(p_tags, '{}')) x where x is null) then
    raise exception 'invalid_input';
  end if;
  select coalesce(array_agg(distinct lower(btrim(x)) order by lower(btrim(x))), '{}') into v
  from unnest(coalesce(p_tags, '{}')) x;
  if exists (select 1 from unnest(v) x where x !~ '^[a-z0-9][a-z0-9-]{0,29}$') or cardinality(v) > 10 then
    raise exception 'invalid_input';
  end if;
  return v;
end $$;

------------------------------------------------------------------------------------------------
-- API
------------------------------------------------------------------------------------------------

create type api.platform_org_note as (
  -- The note's stable id (its first version's id); pass it to platform_add_note to edit.
  id uuid,
  version_id uuid,
  org_id uuid,
  author_id uuid,
  author_email text,
  body text,
  tags text[],
  version int,
  -- When this version was written, and when the note was first written.
  created_at timestamptz,
  first_created_at timestamptz
);
create type api.platform_tagged_org as (
  org_id uuid,
  org_name text,
  status app.org_status,
  tags text[],
  needs_attention boolean,
  notes int,
  last_note_at timestamptz
);
grant usage on type api.platform_org_note, api.platform_tagged_org to authenticated;

/** One stored version as the API shows it. */
create function private.platform_org_note_row(p_version_id uuid) returns api.platform_org_note
language sql stable set search_path = '' as $$
  select r.root_id, n.id, n.org_id, n.author_id, u.email::text, n.body, n.tags, n.version, n.created_at, r.created_at
  from app.platform_org_notes n
  join app.platform_org_notes r on r.id = n.root_id
  left join auth.users u on u.id = n.author_id
  where n.id = p_version_id
$$;

create function api.platform_add_note(
  p_org_id uuid,
  p_body text,
  p_tags text[] default '{}',
  p_note_id uuid default null,
  p_idempotency_key uuid default null
) returns api.platform_org_note
language plpgsql volatile security definer set search_path = '' as $$
declare
  -- btrim alone leaves tabs and newlines, so "blank" is judged on all whitespace.
  v_body text := regexp_replace(coalesce(p_body, ''), '^\s+|\s+$', '', 'g');
  v_tags text[] := private.normalize_note_tags(p_tags);
  v_uid uuid := (select auth.uid());
  v_head app.platform_org_notes;
  v_first app.platform_org_notes;
  v_id uuid;
begin
  perform private.require_platform('support');
  if length(v_body) not between 1 and 4000 then
    raise exception 'invalid_input';
  end if;
  if not exists (select 1 from app.organizations o where o.id = p_org_id) then
    raise exception 'not_found';
  end if;

  -- A retry with the same key returns what the first call stored.
  if p_idempotency_key is not null then
    select n.id into v_id from app.platform_org_notes n
    where n.author_id = v_uid and n.idempotency_key = p_idempotency_key;
    if found then
      return private.platform_org_note_row(v_id);
    end if;
  end if;

  if p_note_id is null then
    v_id := gen_random_uuid();
    insert into app.platform_org_notes (id, org_id, root_id, version, author_id, body, tags, idempotency_key)
    values (v_id, p_org_id, v_id, 1, v_uid, v_body, v_tags, p_idempotency_key);
    perform private.platform_audit('org_note.add', p_org_id,
      jsonb_build_object('note_id', v_id, 'tags', v_tags), null);
    return private.platform_org_note_row(v_id);
  end if;

  -- Edit: serialise on the first version, then write the version after the current one. The note
  -- must belong to p_org_id, so an id from another tenant is not_found.
  select * into v_first from app.platform_org_notes
  where id = p_note_id and root_id = p_note_id and org_id = p_org_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  if v_first.author_id is distinct from v_uid and not private.is_platform('operator') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  select * into v_head from app.platform_org_notes
  where root_id = p_note_id order by version desc limit 1;
  -- Saving what is already current changes nothing.
  if v_head.body = v_body and v_head.tags = v_tags then
    return private.platform_org_note_row(v_head.id);
  end if;
  v_id := gen_random_uuid();
  insert into app.platform_org_notes (id, org_id, root_id, version, author_id, body, tags, idempotency_key)
  values (v_id, p_org_id, p_note_id, v_head.version + 1, v_uid, v_body, v_tags, p_idempotency_key);
  perform private.platform_audit('org_note.edit', p_org_id,
    jsonb_build_object('note_id', p_note_id, 'version', v_head.version + 1, 'tags', v_tags), null);
  return private.platform_org_note_row(v_id);
end $$;
comment on function api.platform_add_note(uuid, text, text[], uuid, uuid) is
  'Support or operator with aal2: adds a note to a tenant, or with p_note_id writes the next '
  'version of that note (its author or an operator only; earlier versions stay). Tags are '
  'lower-cased, trimmed and de-duplicated. A blank or over-4000-character body, a bad tag or '
  'more than 10 tags raise invalid_input. Saving the current text and tags again, or repeating '
  'p_idempotency_key, returns the existing row and writes nothing. Audited without the body. '
  'Raises permission_denied (42501) without a platform role and aal2, or for support editing '
  'another agent''s note; not_found for an unknown org or a note that is not in that org.';

create function api.platform_list_notes(p_org_id uuid, p_include_history boolean default false)
returns setof api.platform_org_note
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform('support');
  if not exists (select 1 from app.organizations o where o.id = p_org_id) then
    raise exception 'not_found';
  end if;
  return query
  select r.root_id, n.id, n.org_id, n.author_id, u.email::text, n.body, n.tags, n.version, n.created_at, r.created_at
  from app.platform_org_notes n
  join app.platform_org_notes r on r.id = n.root_id
  left join auth.users u on u.id = n.author_id
  where n.org_id = p_org_id
    and (coalesce(p_include_history, false)
         or n.version = (select max(x.version) from app.platform_org_notes x where x.root_id = n.root_id))
  order by r.created_at desc, n.root_id, n.version desc;
end $$;
comment on function api.platform_list_notes(uuid, boolean) is
  'Support or operator with aal2: a tenant''s notes, newest first, each at its current version, '
  'or with p_include_history every version. Raises permission_denied (42501) without a platform '
  'role and aal2, not_found for an unknown or purged org.';

create function api.platform_tagged_orgs(p_tags text[] default null)
returns setof api.platform_tagged_org
language plpgsql stable security definer set search_path = '' as $$
declare
  v_filter text[];
begin
  perform private.require_platform('support');
  v_filter := case when p_tags is null or cardinality(p_tags) = 0 then null
                   else private.normalize_note_tags(p_tags) end;
  return query
  with current_notes as (
    select n.* from app.platform_org_notes n
    where n.version = (select max(x.version) from app.platform_org_notes x where x.root_id = n.root_id)
  )
  select o.id, o.name, o.status,
         (select coalesce(array_agg(distinct t order by t), '{}')
            from current_notes c, unnest(c.tags) t where c.org_id = o.id),
         coalesce((select array_agg(distinct t) from current_notes c, unnest(c.tags) t where c.org_id = o.id)
                  && private.note_attention_tags(), false),
         (select count(*)::int from current_notes c where c.org_id = o.id),
         (select max(c.created_at) from current_notes c where c.org_id = o.id)
  from app.organizations o
  where exists (select 1 from current_notes c where c.org_id = o.id and cardinality(c.tags) > 0
                  and (v_filter is null or c.tags && v_filter))
  order by 5 desc, 7 desc, o.id
  limit 500;
end $$;
comment on function api.platform_tagged_orgs(text[]) is
  'Support or operator with aal2: tenants whose notes carry tags, with their tags (the union '
  'over current notes), a needs_attention flag for churn-risk or billing-issue, and the latest '
  'note time. Attention tenants first, then newest. p_tags (or null for any) keeps tenants with '
  'at least one of those tags. At most 500 rows. Raises permission_denied (42501) without a '
  'platform role and aal2, invalid_input for a bad tag.';

revoke all on function api.platform_add_note(uuid, text, text[], uuid, uuid) from public, anon;
revoke all on function api.platform_list_notes(uuid, boolean) from public, anon;
revoke all on function api.platform_tagged_orgs(text[]) from public, anon;
revoke all on function private.platform_org_note_row(uuid), private.normalize_note_tags(text[]),
  private.note_attention_tags(), private.forbid_platform_note_change() from public, anon, authenticated;
grant execute on function api.platform_add_note(uuid, text, text[], uuid, uuid) to authenticated;
grant execute on function api.platform_list_notes(uuid, boolean) to authenticated;
grant execute on function api.platform_tagged_orgs(text[]) to authenticated;
