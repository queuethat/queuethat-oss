-- 2B-C1 (#300): guest tags and notes (C-4).
--
-- Profile-level, not visit-level (S-8 visit notes are separate). Both are org data: the location
-- restriction of a membership does not apply, like app.guests itself. Erasure and retention delete
-- the guest row, so links and notes go with it through on delete cascade (X-5). Notes are free text:
-- the clinic template warns against health information in the UI (2B-C2).

create table app.guest_tags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 40),
  color text check (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz not null default now(),
  unique (org_id, id)
);
create unique index guest_tags_name_idx on app.guest_tags (org_id, lower(name));

create table app.guest_tag_links (
  org_id uuid not null,
  guest_id uuid not null,
  tag_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (guest_id, tag_id),
  foreign key (org_id, guest_id) references app.guests (org_id, id) on delete cascade,
  foreign key (org_id, tag_id) references app.guest_tags (org_id, id) on delete cascade
);
create index guest_tag_links_tag_idx on app.guest_tag_links (org_id, tag_id);

create table app.guest_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  guest_id uuid not null,
  author_user_id uuid references auth.users (id) on delete set null,
  body varchar(2000) not null check (length(btrim(body)) > 0),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (org_id, guest_id) references app.guests (org_id, id) on delete cascade
);
create index guest_notes_guest_idx on app.guest_notes (guest_id, created_at desc);

-- Notes are append-only text: the only change is the soft delete.
revoke update, delete on app.guest_notes from authenticated;
grant update (deleted_at) on app.guest_notes to authenticated;
revoke update on app.guest_tag_links from authenticated;

alter table app.guest_tags enable row level security;
alter table app.guest_tag_links enable row level security;
alter table app.guest_notes enable row level security;

create policy guest_tags_select on app.guest_tags for select to authenticated
  using ((select private.has_role(org_id, null, 'staff')));
create policy guest_tags_insert on app.guest_tags for insert to authenticated
  with check ((select private.has_role(org_id, null, 'manager')));
create policy guest_tags_update on app.guest_tags for update to authenticated
  using ((select private.has_role(org_id, null, 'manager')))
  with check ((select private.has_role(org_id, null, 'manager')));
create policy guest_tags_delete on app.guest_tags for delete to authenticated
  using ((select private.has_role(org_id, null, 'manager')));

create policy guest_tag_links_select on app.guest_tag_links for select to authenticated
  using ((select private.has_role(org_id, null, 'staff')));
create policy guest_tag_links_insert on app.guest_tag_links for insert to authenticated
  with check ((select private.has_role(org_id, null, 'staff')));
create policy guest_tag_links_delete on app.guest_tag_links for delete to authenticated
  using ((select private.has_role(org_id, null, 'staff')));

-- Soft-deleted notes stay readable to admins (evidence) and their author (an UPDATE's new row must
-- still pass the select policy), hidden from everyone else.
create policy guest_notes_select on app.guest_notes for select to authenticated
  using ((select private.has_role(org_id, null, 'staff'))
         and (deleted_at is null or author_user_id = (select auth.uid())
              or (select private.has_role(org_id, null, 'admin'))));
create policy guest_notes_insert on app.guest_notes for insert to authenticated
  with check ((select private.has_role(org_id, null, 'staff'))
              and author_user_id = (select auth.uid()) and deleted_at is null);
create policy guest_notes_update on app.guest_notes for update to authenticated
  using ((select private.has_role(org_id, null, 'staff')) and deleted_at is null
         and (author_user_id = (select auth.uid()) or (select private.has_role(org_id, null, 'admin'))))
  with check (deleted_at is not null);

create trigger forbid_org_change before update on app.guest_tags
  for each row execute function private.forbid_org_change();
create trigger audit_row after insert or update or delete on app.guest_tags
  for each row execute function private.audit_row();
create trigger audit_row after insert or update on app.guest_notes
  for each row execute function private.audit_row();

-- redefines api.export_guest_data from 20261030071000_guest_rights.sql
-- Tags and notes travel in the profile section: api.guest_export has no slot for them and a
-- return type is fixed.
create or replace function api.export_guest_data(p_guest_id uuid) returns api.guest_export
language plpgsql volatile security definer set search_path = '' as $$
declare
  g app.guests;
  r api.guest_export;
begin
  select * into g from app.guests where id = p_guest_id;
  if not found or not private.has_role(g.org_id, null, 'admin') then
    raise exception 'not_found';
  end if;
  perform private.require_aal2_if_enrolled();

  r.guest := to_jsonb(g) || jsonb_build_object(
    'tags', (select coalesce(jsonb_agg(t.name order by t.name), '[]')
             from app.guest_tag_links l join app.guest_tags t on t.id = l.tag_id where l.guest_id = g.id),
    'notes', (select coalesce(jsonb_agg(jsonb_build_object('body', n.body, 'created_at', n.created_at)
                                        order by n.created_at), '[]')
              from app.guest_notes n where n.guest_id = g.id and n.deleted_at is null));
  select coalesce(jsonb_agg(to_jsonb(c) - 'org_id'), '[]') into r.contacts
  from app.guest_contacts c where c.guest_id = g.id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', v.id, 'ticket', v.display_ticket, 'status', v.status, 'name', v.guest_name,
           'phone', v.guest_phone_e164, 'email', v.guest_email, 'party_size', v.party_size,
           'source', v.source, 'joined_at', v.joined_at, 'called_at', v.called_at,
           'serving_at', v.serving_at, 'finished_at', v.finished_at) order by v.joined_at), '[]')
    into r.visits from app.visits v where v.guest_id = g.id;
  select coalesce(jsonb_agg(to_jsonb(a) - 'guest_token_hash' - 'org_id' order by a.starts_at), '[]')
    into r.appointments from app.appointments a where a.guest_id = g.id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', n.id, 'visit_id', n.visit_id, 'channel', n.channel, 'template', n.template_key,
           'status', n.status, 'created_at', n.created_at) order by n.created_at), '[]')
    into r.notifications
  from app.notifications n
  where n.org_id = g.org_id and (n.visit_id in (select v.id from app.visits v where v.guest_id = g.id)
        or n.recipient_ref in (select c.id from app.guest_contacts c where c.guest_id = g.id));
  select coalesce(jsonb_agg(to_jsonb(k) - 'org_id' order by k.captured_at), '[]') into r.consents
  from app.consents k where k.contact_id in (select c.id from app.guest_contacts c where c.guest_id = g.id);
  r.generated_at := now();

  insert into app.audit_log (org_id, actor, role, action, table_name, row_id)
  values (g.org_id, (select auth.uid()), 'admin', 'EXPORT', 'guests', g.id::text);
  return r;
end $$;
