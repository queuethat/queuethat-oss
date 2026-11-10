-- #930: how the dispatcher must send one whatsapp row. The adapter sends free text inside the guest's
-- 24 h window and an approved template outside it; claim_outbox does not say which, so this does.
-- A new function rather than new attributes on api.outbox_job (a Phase-0 type) and a copy of the
-- claim_outbox body; it reuses the decision enqueue and outbox_still_relevant already make.

create function api.get_whatsapp_send(p_outbox_id uuid)
returns table (mode text, wa_name text, wa_language text, window_open boolean)
language sql stable security definer set search_path = '' as $$
  select d.mode, w.wa_name, w.wa_language,
         coalesce(gc.whatsapp_window_until > now(), false)
  from app.notifications n
  left join app.visits v on v.id = n.visit_id
  left join app.appointments ap on ap.id = n.appointment_id
  left join app.guest_contacts gc on gc.id = n.recipient_ref and gc.org_id = n.org_id
  cross join lateral private.whatsapp_decision(n.org_id, n.recipient_ref, n.category,
                                               coalesce(v.queue_id, ap.queue_id),
                                               coalesce(v.locale, ap.locale, 'en'), n.template_key) d
  left join lateral (
    select wt.wa_name, wt.wa_language
    from private.resolve_template(n.org_id, coalesce(v.queue_id, ap.queue_id), n.template_key, 'whatsapp',
                                  coalesce(v.locale, ap.locale, 'en')) t
    join app.whatsapp_templates wt on wt.template_id = t.id and wt.org_id = n.org_id and wt.status = 'approved'
    limit 1
  ) w on true
  where n.id = p_outbox_id and n.channel = 'whatsapp'
$$;
comment on function api.get_whatsapp_send(uuid) is
  'Service role only (dispatcher): for one whatsapp outbox row, the current send mode (session = free text inside the '
  'contact''s 24 h window, template = the approved template named by wa_name and wa_language, null = not allowed now), '
  'whether the window is open, and the approved template mapping if there is one. No rows for an unknown or non-whatsapp row.';
revoke all on function api.get_whatsapp_send(uuid) from public, anon, authenticated;
grant execute on function api.get_whatsapp_send(uuid) to service_role;

notify pgrst, 'reload schema';
