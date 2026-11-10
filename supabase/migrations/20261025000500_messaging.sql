-- S4 (#25): guests, contacts, consent, suppression and the notification outbox.
--
-- These tables exist from phase 1 so phase 3 swaps a provider, not a schema (technical-design.md 4
-- and 6). Only definer functions and the service role (the dispatcher) write them; staff read
-- under RLS. Contact data never appears in guest-facing responses or realtime payloads.

create type app.contact_channel as enum ('phone', 'email');
create type app.notification_channel as enum ('push', 'email', 'sms', 'whatsapp', 'console');
create type app.notification_status as enum ('queued', 'claimed', 'sent', 'failed', 'dead', 'suppressed');
create type app.message_category as enum ('transactional', 'marketing');
grant usage on type app.contact_channel, app.notification_channel, app.notification_status,
  app.message_category to authenticated, service_role;

create table app.guests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  first_name text check (length(first_name) <= 60),
  created_at timestamptz not null default now(),
  anonymized_at timestamptz,
  unique (org_id, id)
);

create table app.guest_contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  guest_id uuid not null,
  channel app.contact_channel not null,
  -- E.164 for phone (+14155550123), lower-cased address for email.
  value text not null,
  country_code text check (country_code ~ '^[A-Z]{2}$'),
  verified_at timestamptz,
  created_source text not null check (created_source in ('online', 'staff', 'kiosk', 'import')),
  created_at timestamptz not null default now(),
  check (channel <> 'phone' or value ~ '^\+[1-9][0-9]{6,14}$'),
  check (channel <> 'email' or (value = lower(value) and value like '%_@_%')),
  foreign key (org_id, guest_id) references app.guests (org_id, id) on delete cascade,
  unique (org_id, channel, value),
  unique (org_id, id)
);

create table app.consents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  contact_id uuid not null,
  channel app.notification_channel not null,
  purpose app.message_category not null,
  status text not null check (status in ('granted', 'revoked')),
  captured_at timestamptz not null default now(),
  source text not null check (source in ('online', 'staff', 'kiosk', 'inbound', 'import')),
  consent_text_version text not null,
  consent_text_hash text not null,
  captured_by_user_id uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  revoked_via text,
  foreign key (org_id, contact_id) references app.guest_contacts (org_id, id) on delete cascade,
  unique (org_id, id)
);
create index consents_contact_idx on app.consents (contact_id, channel, purpose);

create table app.suppressions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  channel app.notification_channel not null,
  value text not null,
  reason text not null check (reason in ('stop', 'bounce', 'complaint', 'manual')),
  created_at timestamptz not null default now(),
  unique (org_id, channel, value)
);

-- org_id null = a system default template, overridable per org or per queue.
create table app.notification_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references app.organizations (id) on delete cascade,
  queue_id uuid,
  trigger text not null check (trigger in ('called', 'almost_up')),
  channel app.notification_channel not null,
  locale text not null default 'en',
  category app.message_category not null default 'transactional',
  subject text,
  body text not null,
  version int not null default 1,
  created_at timestamptz not null default now(),
  check (queue_id is null or org_id is not null),
  foreign key (org_id, queue_id) references app.queues (org_id, id) on delete cascade
);
create unique index notification_templates_scope_idx on app.notification_templates
  (coalesce(org_id, '00000000-0000-0000-0000-000000000000'), coalesce(queue_id, '00000000-0000-0000-0000-000000000000'),
   trigger, channel, locale);

create table app.notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  visit_id uuid not null,
  event_id bigint references app.visit_events (id),
  channel app.notification_channel not null,
  -- push_subscriptions.id or guest_contacts.id; never the raw address
  recipient_ref uuid not null,
  template_key text not null,
  template_version int not null,
  category app.message_category not null default 'transactional',
  -- Variables snapshotted at enqueue time (ticket, counter label...). No contact data.
  vars jsonb not null default '{}',
  dedupe_key text not null unique,
  consent_id uuid references app.consents (id),
  status app.notification_status not null default 'queued',
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  provider text,
  provider_message_id text,
  error_code text,
  segments int,
  cost_micros bigint,
  quiet_hours_deferred boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, visit_id) references app.visits (org_id, id)
);
create index notifications_due_idx on app.notifications (next_attempt_at) where status in ('queued', 'failed');
create index notifications_visit_idx on app.notifications (visit_id);

create table app.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  visit_id uuid not null,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  foreign key (org_id, visit_id) references app.visits (org_id, id),
  unique (visit_id, endpoint)
);

-- What the console provider "sent", for local development and tests.
create table app.dev_inbox (
  id bigint generated always as identity primary key,
  org_id uuid not null references app.organizations (id) on delete cascade,
  notification_id uuid references app.notifications (id),
  channel app.notification_channel not null,
  recipient text not null,
  subject text,
  body text not null,
  created_at timestamptz not null default now()
);

alter table app.visits
  add foreign key (org_id, guest_id) references app.guests (org_id, id),
  add foreign key (org_id, contact_id) references app.guest_contacts (org_id, id);

create trigger touch_updated_at before update on app.notifications
  for each row execute function private.touch_updated_at();
create trigger forbid_org_change before update on app.notification_templates
  for each row execute function private.forbid_org_change();
create trigger audit_row after insert or update or delete on app.notification_templates
  for each row execute function private.audit_row();

------------------------------------------------------------------------------------------------
-- Default templates (English). {ticket} and {counter} are filled from notifications.vars.
------------------------------------------------------------------------------------------------

insert into app.notification_templates (trigger, channel, subject, body) values
  ('called',    'push',    null, 'It''s your turn: {ticket}. Please go to {counter}.'),
  ('almost_up', 'push',    null, 'You''re almost up ({ticket}). Please head back now.'),
  ('called',    'email',   'It''s your turn', 'It''s your turn: {ticket}. Please go to {counter}.'),
  ('almost_up', 'email',   'You''re almost up', 'You''re almost up ({ticket}). Please head back now.'),
  ('called',    'console', null, 'It''s your turn: {ticket}. Please go to {counter}.'),
  ('almost_up', 'console', null, 'You''re almost up ({ticket}). Please head back now.');

------------------------------------------------------------------------------------------------
-- Privileges and row-level security
------------------------------------------------------------------------------------------------

revoke insert, update, delete, truncate on app.guests, app.guest_contacts, app.consents,
  app.suppressions, app.notifications, app.push_subscriptions, app.dev_inbox from authenticated;

alter table app.guests enable row level security;
alter table app.guest_contacts enable row level security;
alter table app.consents enable row level security;
alter table app.suppressions enable row level security;
alter table app.notification_templates enable row level security;
alter table app.notifications enable row level security;
alter table app.push_subscriptions enable row level security;
alter table app.dev_inbox enable row level security;

create policy guests_select on app.guests for select to authenticated
  using ((select private.has_role(org_id, null, 'staff')));
create policy guest_contacts_select on app.guest_contacts for select to authenticated
  using ((select private.has_role(org_id, null, 'staff')));
create policy consents_select on app.consents for select to authenticated
  using ((select private.has_role(org_id, null, 'manager')));
create policy suppressions_select on app.suppressions for select to authenticated
  using ((select private.has_role(org_id, null, 'manager')));

create policy notification_templates_select on app.notification_templates for select to authenticated
  using (org_id is null or (select private.has_role(org_id, null, 'staff')));
create policy notification_templates_insert on app.notification_templates for insert to authenticated
  with check (org_id is not null and (select private.has_role(org_id, null, 'admin')));
create policy notification_templates_update on app.notification_templates for update to authenticated
  using (org_id is not null and (select private.has_role(org_id, null, 'admin')))
  with check (org_id is not null and (select private.has_role(org_id, null, 'admin')));
create policy notification_templates_delete on app.notification_templates for delete to authenticated
  using (org_id is not null and (select private.has_role(org_id, null, 'admin')));

-- Staff see delivery status (N-12), including dead letters.
create policy notifications_select on app.notifications for select to authenticated
  using ((select private.has_role(org_id, null, 'staff')));
create policy push_subscriptions_select on app.push_subscriptions for select to authenticated
  using ((select private.has_role(org_id, null, 'admin')));
create policy dev_inbox_select on app.dev_inbox for select to authenticated
  using ((select private.has_role(org_id, null, 'admin')));
