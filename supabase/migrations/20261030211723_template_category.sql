-- 3-CG7 (#332): marketing vs transactional categories are enforced in the database.
--
--   * A marketing template may only be the broadcast template. Visit-event triggers (called,
--     almost_up, ...) are transactional by law, so they can never carry promotion.
--   * Every notification's category equals its resolved template's category.
--   * A marketing notification without a granted, unrevoked `marketing` consent for the same
--     contact and channel is stored as suppressed (error_code no_marketing_consent): visible in
--     the delivery log, never claimable. claim_outbox re-checks consent per category at send time.

alter table app.notification_templates add constraint notification_templates_marketing_trigger_check
  check (category = 'transactional' or trigger = 'broadcast');

create function private.enforce_notification_category() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
declare v_category app.message_category;
begin
  select t.category into v_category
  from app.visits v
  cross join lateral private.resolve_template(v.org_id, v.queue_id, new.template_key, new.channel,
                                              coalesce(v.locale, 'en')) t
  where v.id = new.visit_id;
  if v_category is not null and v_category <> new.category then
    raise exception 'category_mismatch';
  end if;

  if new.category = 'marketing' and new.status = 'queued' and not coalesce((
       select c.status = 'granted' and c.revoked_at is null
       from app.consents c
       where c.contact_id = new.recipient_ref and c.channel = new.channel and c.purpose = 'marketing'
       order by c.captured_at desc limit 1), false) then
    new.status := 'suppressed';
    new.error_code := 'no_marketing_consent';
  end if;
  return new;
end $$;
revoke all on function private.enforce_notification_category() from public, anon, authenticated;
comment on function private.enforce_notification_category() is
  'Before insert on notifications: rejects category_mismatch with the resolved template, and stores a '
  'marketing row as suppressed (no_marketing_consent) unless the contact''s latest marketing consent is granted.';

create trigger enforce_category before insert on app.notifications
  for each row execute function private.enforce_notification_category();
