-- 3-WA4 (#361): staff can see the WhatsApp template mappings (read-only admin page); owners and
-- admins still write them. Mappings are names and statuses, no contact data, and notification_templates
-- is already readable by staff.
drop policy whatsapp_templates_select on app.whatsapp_templates;
create policy whatsapp_templates_select on app.whatsapp_templates for select to authenticated
  using ((select private.has_role(org_id, null, 'staff')));
