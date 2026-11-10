-- T1 (#1295): the template catalog as a table. Content ships as rows (one migration per batch), each
-- template versioned; applying copies the payload into the org's own rows and stamps where it came from.
-- Alternatives (rule 7): keep private.industry_templates() as SQL (every edit redefines a huge function)
-- vs a catalog table (chosen: edits are inserts, copies are provably independent).
--
-- Expand step: app.queues gains nullable origin columns; private.industry_templates() stays and now reads
-- the catalog, so api.list_industry_templates keeps its signature and behaviour.

create table app.template_catalog (
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  version int not null check (version >= 1),
  -- name, description, queues (services, prefixes), resources, as consumed by api.apply_industry_template.
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  -- 1 = reviewed launch catalog, 2 and 3 = later or unreviewed (design 12.2).
  tier int not null check (tier between 1 and 3),
  mode text not null check (mode in ('walk_in', 'booking', 'both')),
  health_tagged boolean not null default false,
  published_at timestamptz not null default now(),
  primary key (key, version)
);
comment on table app.template_catalog is
  'Read-only setup templates, identical for every tenant. Versions are immutable: a change is a new '
  'version row inserted by a migration. Tenants never write it; applying a template copies the payload.';
alter table app.template_catalog enable row level security;
create policy template_catalog_select on app.template_catalog for select to authenticated using (true);
revoke all on app.template_catalog from public, anon, authenticated, service_role;
grant select on app.template_catalog to authenticated, service_role;

create function private.forbid_catalog_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'catalog_version_immutable';
end $$;
comment on function private.forbid_catalog_change() is
  'BEFORE UPDATE/DELETE trigger on app.template_catalog: a published version never changes; add a new one.';
revoke all on function private.forbid_catalog_change() from public, anon, authenticated;
create trigger forbid_catalog_change before update or delete on app.template_catalog
  for each row execute function private.forbid_catalog_change();

-- The six existing templates become version 1 (unreviewed, so tier 2; T5 to T8 publish reviewed v2s).
insert into app.template_catalog (key, version, payload, tier, mode, health_tagged)
select t.key, 1, t.value - 'health_tagged', 2, 'walk_in', (t.value ->> 'health_tagged')::boolean
from jsonb_each(private.industry_templates()) t(key, value);

alter table app.queues add column origin_template text, add column origin_version int;
comment on column app.queues.origin_template is 'Catalog key this queue was copied from; null when hand-made.';
comment on column app.queues.origin_version is 'Catalog version this queue was copied from.';

-- redefines private.industry_templates from 20261030080518_templates_party_size_prefix.sql
create or replace function private.industry_templates() returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_object_agg(c.key, c.payload || jsonb_build_object('health_tagged', c.health_tagged)), '{}')
  from (select distinct on (key) * from app.template_catalog order by key, version desc) c
$$;
comment on function private.industry_templates() is
  'The newest version of each catalog template as jsonb keyed by template key (payload plus health_tagged).';

-- redefines api.apply_industry_template from 20261030080518_templates_party_size_prefix.sql
create or replace function api.apply_industry_template(p_location_id uuid, p_template_key text, p_idempotency_key uuid)
returns api.template_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  loc app.locations;
  tpl jsonb;
  v_version int;
  claim record;
  q jsonb;
  s jsonb;
  r jsonb;
  v_queue app.queues;
  result api.template_result;
begin
  select * into loc from app.locations l where l.id = p_location_id;
  if not found or not private.has_role(loc.org_id, loc.id, 'staff') then
    raise exception 'not_found';
  end if;
  if not private.has_role(loc.org_id, loc.id, 'admin') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  -- The newest catalog version; the rows created below are copies that later versions never touch.
  select c.payload || jsonb_build_object('health_tagged', c.health_tagged), c.version into tpl, v_version
  from app.template_catalog c
  where c.key = p_template_key order by c.version desc limit 1;
  if tpl is null or p_idempotency_key is null then raise exception 'not_found'; end if;

  select * into claim from private.claim_idempotent(loc.org_id, 'apply_industry_template', p_idempotency_key);
  if claim.replay then
    if claim.response ->> 'template_key' is distinct from p_template_key then
      raise exception 'invalid_input'; -- the key was used for a different template
    end if;
    return jsonb_populate_record(null::api.template_result, claim.response);
  end if;
  if exists (select 1 from app.visits v
             where v.location_id = loc.id and v.service_day = private.service_day(loc.id)) then
    raise exception 'invalid_input' using detail = 'location_has_visits';
  end if;

  result := row(p_template_key, 0, 0, 0);
  if (tpl ->> 'health_tagged')::boolean then
    -- The tag covers the whole organization, so it needs an org-wide admin, not one scoped to a place.
    if not private.has_role(loc.org_id, null, 'admin') then
      raise exception 'permission_denied' using errcode = '42501';
    end if;
    update app.locations set display_names_enabled = false where org_id = loc.org_id and display_names_enabled;
    update app.organizations set health_tagged = true where id = loc.org_id;
  end if;

  for q in select * from jsonb_array_elements(tpl -> 'queues') loop
    -- Applying again, or after hand-made setup, never duplicates a queue of the same name.
    select * into v_queue from app.queues x
    where x.location_id = loc.id and x.archived_at is null and x.name = q ->> 'name';
    if not found then
      insert into app.queues (org_id, location_id, name, ticket_prefix, show_eta,
                              party_size_enabled, party_size_min, party_size_max,
                              origin_template, origin_version)
      values (loc.org_id, loc.id, q ->> 'name', q ->> 'prefix', (q ->> 'show_eta')::boolean,
              q ? 'party_max', coalesce((q ->> 'party_min')::int, 1), coalesce((q ->> 'party_max')::int, 1),
              p_template_key, v_version)
      returning * into v_queue;
      result.queues_created := result.queues_created + 1;
    end if;
    for s in select * from jsonb_array_elements(q -> 'services') loop
      if not exists (select 1 from app.services x where x.queue_id = v_queue.id and x.name = s ->> 'name') then
        insert into app.services (org_id, location_id, queue_id, name, expected_minutes, ticket_prefix)
        values (loc.org_id, loc.id, v_queue.id, s ->> 'name', (s ->> 'minutes')::int, s ->> 'prefix');
        result.services_created := result.services_created + 1;
      end if;
    end loop;
  end loop;
  for r in select * from jsonb_array_elements(tpl -> 'resources') loop
    if not exists (select 1 from app.counters x
                   where x.location_id = loc.id and x.archived_at is null and x.label = r ->> 'label') then
      insert into app.counters (org_id, location_id, label, kind, seats)
      values (loc.org_id, loc.id, r ->> 'label', (r ->> 'kind')::app.resource_kind, (r ->> 'seats')::int);
      result.counters_created := result.counters_created + 1;
    end if;
  end loop;

  perform private.save_idempotent('apply_industry_template', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.apply_industry_template(uuid, text, uuid) is
  'Creates the template''s queues, services and counters in the location, skipping any with the '
  'same name already there. Owner or admin of the location; refuses (invalid_input, detail '
  'location_has_visits) when the location already has visits in the current service day. A clinic '
  'template tags the organization health_tagged and turns names off on displays for good. Raises '
  'not_found (unknown template or a location the caller cannot see), permission_denied (42501, a '
  'member below admin). Idempotent per key. Uses the newest catalog version and stamps origin_template and origin_version '
  'on the queues it creates. Implemented by 2A-ORG4, T1 (#1295).';


------------------------------------------------------------------------------------------------
-- api.list_template_catalog: the newest version of each template, for the picker and the preview
------------------------------------------------------------------------------------------------

create type api.template_catalog_entry as (
  key text,
  version int,
  name text,
  description text,
  tier int,
  mode text,
  health_tagged boolean,
  payload jsonb
);
grant usage on type api.template_catalog_entry to authenticated, service_role;

create function api.list_template_catalog()
returns setof api.template_catalog_entry
language sql stable security invoker set search_path = '' as $$
  select c.key, c.version, c.payload ->> 'name', c.payload ->> 'description', c.tier, c.mode, c.health_tagged, c.payload
  from (select distinct on (key) * from app.template_catalog order by key, version desc) c
  order by c.tier, c.key
$$;
comment on function api.list_template_catalog() is
  'The newest version of every catalog template with its payload, tier 1 first. Any signed-in user, '
  'including one who has not created an organization yet; anon is denied (42501). Read-only: templates '
  'are applied by api.apply_industry_template, which copies them.';
revoke all on function api.list_template_catalog() from public, anon, authenticated, service_role;
grant execute on function api.list_template_catalog() to authenticated, service_role;
