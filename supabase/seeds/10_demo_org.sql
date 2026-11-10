-- S6 (#27): deterministic demo data. Never applied to the pilot.
--
-- Sign in locally with any of these (password: password123):
--   owner@demo.test    owner of Demo Barber
--   staff@demo.test    staff at Demo Barber
--   owner@e2e.test     owner of Demo Barber (Playwright)
--   staff@e2e.test     staff at Demo Barber (Playwright)
--   owner@other.test   owner of Other Salon (cross-tenant checks)
--   ops@demo.test      platform operator (no org). The console needs an aal2 session, so
--                      enrol a TOTP factor on first sign-in; platform_whoami works without one.
-- Guests join at http://localhost:5173/q/demo-barber
--
-- Ids are fixed so tests, docs and tests/fixtures/demo.ts can refer to them.

create function pg_temp.seed_user(p_id uuid, p_email text) returns void
language sql as $$
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change,
                          email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  values (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email,
          extensions.crypt(coalesce(nullif(current_setting('qm.demo_password', true), ''), 'password123'), extensions.gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}', '{}', now(), now(),
          '', '', '', '', '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), p_id, p_id::text, 'email',
          jsonb_build_object('sub', p_id::text, 'email', p_email, 'email_verified', true), now(), now(), now());
$$;

select pg_temp.seed_user('00000000-0000-4000-8000-0000000000a1', 'owner@demo.test');
select pg_temp.seed_user('00000000-0000-4000-8000-0000000000a2', 'staff@demo.test');
select pg_temp.seed_user('00000000-0000-4000-8000-0000000000a3', 'owner@e2e.test');
select pg_temp.seed_user('00000000-0000-4000-8000-0000000000a4', 'staff@e2e.test');
select pg_temp.seed_user('00000000-0000-4000-8000-0000000000b1', 'owner@other.test');
-- The self-host demo (deploy/selfhost) sets qm.demo_password and qm.demo_ops=off: no shared
-- password, and no platform operator whose first sign-in would enrol the TOTP factor.
select pg_temp.seed_user('00000000-0000-4000-8000-0000000000c1', 'ops@demo.test')
  where current_setting('qm.demo_ops', true) is distinct from 'off';

-- Demo Barber: one location in New York, two queues, three services, two counters.
insert into app.organizations (id, name, created_by) values
  ('00000000-0000-4000-8000-00000000d001', 'Demo Barber', '00000000-0000-4000-8000-0000000000a1'),
  ('00000000-0000-4000-8000-00000000e001', 'Other Salon', '00000000-0000-4000-8000-0000000000b1');

insert into app.channel_limits (org_id, channel, country_allowlist) values
  ('00000000-0000-4000-8000-00000000d001', 'sms', '{US,CA}'),
  ('00000000-0000-4000-8000-00000000d001', 'whatsapp', '{US,CA}');

insert into app.locations (id, org_id, name, slug, tz, address, contact, country_code) values
  ('00000000-0000-4000-8000-00000000d101', '00000000-0000-4000-8000-00000000d001',
   'Demo Barber Main Street', 'demo-barber', 'America/New_York', '1 Main Street, New York, NY', '+1 212 555 0100', 'US'),
  ('00000000-0000-4000-8000-00000000e101', '00000000-0000-4000-8000-00000000e001',
   'Other Salon Berlin', 'other-salon', 'Europe/Berlin', 'Hauptstraße 1, Berlin', null, 'DE');

insert into app.memberships (org_id, user_id, role) values
  ('00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-0000000000a1', 'owner'),
  ('00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-0000000000a2', 'staff'),
  ('00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-0000000000a3', 'owner'),
  ('00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-0000000000a4', 'staff'),
  ('00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-0000000000b1', 'owner');

insert into app.queues (id, org_id, location_id, name, ticket_prefix, servers_on_duty) values
  ('00000000-0000-4000-8000-00000000d201', '00000000-0000-4000-8000-00000000d001',
   '00000000-0000-4000-8000-00000000d101', 'Walk-ins', 'A', 2),
  ('00000000-0000-4000-8000-00000000d202', '00000000-0000-4000-8000-00000000d001',
   '00000000-0000-4000-8000-00000000d101', 'Kids', 'K', 1),
  ('00000000-0000-4000-8000-00000000e201', '00000000-0000-4000-8000-00000000e001',
   '00000000-0000-4000-8000-00000000e101', 'Walk-ins', 'A', 1);

insert into app.services (id, org_id, location_id, queue_id, name, expected_minutes, color) values
  ('00000000-0000-4000-8000-00000000d301', '00000000-0000-4000-8000-00000000d001',
   '00000000-0000-4000-8000-00000000d101', '00000000-0000-4000-8000-00000000d201', 'Haircut', 20, '#2563eb'),
  ('00000000-0000-4000-8000-00000000d302', '00000000-0000-4000-8000-00000000d001',
   '00000000-0000-4000-8000-00000000d101', '00000000-0000-4000-8000-00000000d201', 'Beard trim', 10, '#16a34a'),
  ('00000000-0000-4000-8000-00000000d303', '00000000-0000-4000-8000-00000000d001',
   '00000000-0000-4000-8000-00000000d101', '00000000-0000-4000-8000-00000000d202', 'Kids cut', 15, '#f59e0b'),
  ('00000000-0000-4000-8000-00000000e301', '00000000-0000-4000-8000-00000000e001',
   '00000000-0000-4000-8000-00000000e101', '00000000-0000-4000-8000-00000000e201', 'Haarschnitt', 30, null);

insert into app.counters (id, org_id, location_id, label, sort_order) values
  ('00000000-0000-4000-8000-00000000d401', '00000000-0000-4000-8000-00000000d001',
   '00000000-0000-4000-8000-00000000d101', 'Chair 1', 1),
  ('00000000-0000-4000-8000-00000000d402', '00000000-0000-4000-8000-00000000d001',
   '00000000-0000-4000-8000-00000000d101', 'Chair 2', 2);

-- PLT1 (#407): the demo operator. The audit trigger records the grant like any other.
insert into app.platform_roles (user_id, role)
select '00000000-0000-4000-8000-0000000000c1', 'operator'
  where current_setting('qm.demo_ops', true) is distinct from 'off';
