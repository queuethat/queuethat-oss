-- M2c-2 (#1339): the queue scope from M1/M2/M2b/M2c-1 also binds the last staff entry points that name a
-- visit or queue: log_manual_contact, advance_journey, set_visit_answers and send_queue_message. With
-- organizations.scope_staff_to_lines off nothing changes. With it on, a scoped staff member gets not_found
-- for a visit or queue outside their queue_ids; unscoped staff, managers and above are unaffected. Only the
-- staff has_role test changes, to private.has_queue_access; send_queue_message keeps its manager check after
-- it. Signatures, grants and comments stay.
--
-- Alternatives (rule 7): one shared check helper (rejected: each function loads its own row first) vs
-- replacing the test in each entry point (chosen, as in M2).

-- redefines api.log_manual_contact from 20261030175947_manual_contact.sql
create or replace function api.log_manual_contact(p_visit_id uuid, p_channel text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_channel is distinct from 'whatsapp' then
    raise exception 'invalid_input';
  end if;
  if v.guest_phone_e164 is null then
    raise exception 'no_contact';
  end if;
  -- An SMS STOP or a manual block is an opt-out of the number, whatever app staff would use.
  if exists (select 1 from app.suppressions s
             where s.org_id = v.org_id and s.channel in ('sms', 'whatsapp') and s.value = v.guest_phone_e164) then
    raise exception 'suppressed';
  end if;
  insert into app.audit_log (org_id, actor, role, action, table_name, row_id, after)
  values (v.org_id, auth.uid(), 'staff', 'INSERT', 'manual_contact', v.id::text,
          jsonb_build_object('channel', p_channel, 'visit_id', v.id));
  return v.guest_phone_e164;
end $$;

-- redefines api.advance_journey from 20261030181012_journeys.sql
create or replace function api.advance_journey(p_visit_id uuid, p_expected_version int, p_idempotency_key uuid)
returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  claim record;
  pl record;
  v_journey uuid;
  cur app.journey_steps;
  nxt app.journey_steps;
  tq app.queues;
  v_after uuid;
  v_number int;
  v_display text;
  result api.visit_row;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_expected_version is null or p_idempotency_key is null then
    raise exception 'invalid_input';
  end if;

  select * into claim from private.claim_idempotent(v.org_id, 'advance_journey', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  select * into v from app.visits where id = p_visit_id for update;
  if v.version <> p_expected_version then
    raise exception 'stale_visit';
  end if;
  if v.status <> 'serving' then
    raise exception 'illegal_transition' using detail = format('advance from %s', v.status);
  end if;

  v_journey := coalesce(v.journey_id, (select s.journey_id from app.services s where s.id = v.service_id));
  select js.* into cur
  from app.journey_steps js join app.journeys j on j.id = js.journey_id and j.active
  where js.journey_id = v_journey and js.queue_id = v.queue_id;
  if not found then
    raise exception 'illegal_transition' using detail = 'no journey step for this visit';
  end if;
  select * into nxt from app.journey_steps where journey_id = v_journey and step_no = cur.step_no + 1;

  if not found then
    -- The last step is the end of the visit.
    result := api.transition_visit(v.id, 'complete', v.version, gen_random_uuid());
    perform private.save_idempotent('advance_journey', p_idempotency_key, to_jsonb(result));
    return result;
  end if;

  select * into tq from app.queues where id = nxt.queue_id and org_id = v.org_id
    and location_id = v.location_id and archived_at is null;
  if not found then
    raise exception 'not_found';
  end if;

  -- Filed behind everyone already waiting there.
  select w.id into v_after
  from app.visits w
  where w.queue_id = tq.id and w.service_day = v.service_day and w.status = 'waiting'
  order by w.sort_key desc, w.id desc
  limit 1;
  select * into pl from private.place_in_queue(tq.id, v.service_day, v.id, v_after);

  -- The ticket stays unless the target queue issues the same prefix or already holds the number.
  v_number := v.ticket_number;
  v_display := v.display_ticket;
  if tq.ticket_prefix = v.ticket_prefix or exists (
    select 1 from app.visits t
    where t.queue_id = tq.id and t.service_day = v.service_day
      and t.ticket_prefix = v.ticket_prefix and t.ticket_number = v.ticket_number) then
    loop
      v_number := private.next_ticket(tq.id, v.ticket_prefix, v.service_day);
      exit when not exists (
        select 1 from app.visits t
        where t.queue_id = tq.id and t.service_day = v.service_day
          and t.ticket_prefix = v.ticket_prefix and t.ticket_number = v_number);
    end loop;
    v_display := v.ticket_prefix || lpad(v_number::text, greatest(3, length(v_number::text)), '0');
  end if;

  perform private.set_actor('staff', (select auth.uid()), 'transferred', null,
    jsonb_build_object('journey_id', v_journey, 'from_step', cur.step_no, 'to_step', nxt.step_no,
                       'from_queue_id', v.queue_id, 'to_queue_id', tq.id,
                       'from_service_id', v.service_id, 'to_service_id', nxt.service_id,
                       'from_sort_key', v.sort_key, 'to_sort_key', pl.new_sort_key,
                       'from_after_visit_id', null, 'to_after_visit_id', v_after,
                       'from_ticket_number', v.ticket_number, 'to_ticket_number', v_number,
                       'from_display_ticket', v.display_ticket, 'to_display_ticket', v_display,
                       'previous_counter_id', v.counter_id, 'renumbered', pl.renumbered));
  update app.visits
  set status = 'waiting', queue_id = tq.id, service_id = nxt.service_id, sort_key = pl.new_sort_key,
      ticket_number = v_number, display_ticket = v_display, journey_id = v_journey, counter_id = null
  where id = v.id;
  perform private.bump_queue_version(v.queue_id);
  perform private.bump_queue_version(tq.id);

  result := private.visit_row(v.id);
  perform private.save_idempotent('advance_journey', p_idempotency_key, to_jsonb(result));
  return result;
end $$;

-- redefines api.set_visit_answers from 20261109094337_forms_engine.sql
create or replace function api.set_visit_answers(p_visit_id uuid, p_answers jsonb, p_expected_version int, p_idempotency_key uuid)
returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  claim record;
  v_answers jsonb;
  v_ver uuid;
  result api.visit_row;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_expected_version is null or p_idempotency_key is null then
    raise exception 'invalid_input';
  end if;
  -- Validated against the version the visit was asked (else the one a walk-in would get now).
  v_ver := (select r.form_version_id from app.form_responses r where r.visit_id = v.id order by r.created_at limit 1);
  v_ver := coalesce(v_ver, private.resolve_form(v.queue_id, v.service_id));
  v_answers := private.validate_form_answers(
    v.org_id, coalesce((select fv.fields from app.form_versions fv where fv.id = v_ver), '[]'), p_answers, 'staff');

  select * into claim from private.claim_idempotent(v.org_id, 'set_visit_answers', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  select * into v from app.visits where id = p_visit_id for update;
  if v.version <> p_expected_version then
    raise exception 'stale_visit';
  end if;

  if v_answers = '{}' then
    delete from app.visit_answers where visit_id = v.id;
  else
    insert into app.visit_answers (org_id, location_id, visit_id, answers)
    values (v.org_id, v.location_id, v.id, v_answers)
    on conflict (visit_id) do update set answers = excluded.answers;
  end if;
  if v_ver is not null then
    insert into app.form_responses (org_id, location_id, form_version_id, visit_id, answers)
    values (v.org_id, v.location_id, v_ver, v.id, v_answers)
    on conflict (visit_id, form_version_id) where visit_id is not null do update set answers = excluded.answers;
  end if;
  -- The event names the answered keys, never the values.
  perform private.set_actor('staff', (select auth.uid()));
  perform private.record_visit_event(v.id, 'answers_updated',
                                     jsonb_build_object('keys', (select coalesce(jsonb_agg(k order by k), '[]') from jsonb_object_keys(v_answers) k)));

  result := private.visit_row(v.id);
  perform private.save_idempotent('set_visit_answers', p_idempotency_key, to_jsonb(result));
  return result;
end $$;

-- redefines api.send_queue_message from 20261107204944_sms_broadcast_guard.sql
create or replace function api.send_queue_message(p_queue_id uuid, p_body text, p_idempotency_key uuid)
returns api.broadcast_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  q app.queues;
  uid uuid := (select auth.uid());
  blocked text;
  claim record;
  v_body text := btrim(coalesce(p_body, ''));
  bad text;
  b app.queue_broadcasts;
  w app.visits;
  eta record;
  vars jsonb;
  n_recipients int := 0;
  n_suppressed int := 0;
  result api.broadcast_result;
begin
  select * into q from app.queues where id = p_queue_id and archived_at is null;
  if not found or not private.has_queue_access(q.org_id, q.id, 'staff') then
    raise exception 'not_found';
  end if;
  if not private.has_role(q.org_id, q.location_id, 'manager') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  blocked := private.write_blocked_reason(q.org_id, 'staff', uid);
  if blocked is not null then
    raise exception '%', blocked using errcode = '42501';
  end if;
  if p_idempotency_key is null or length(v_body) not between 1 and 320 then
    raise exception 'invalid_input';
  end if;
  if private.template_malformed(v_body) then
    raise exception 'unknown_variable' using detail = 'malformed placeholder';
  end if;
  select u into bad from unnest(private.template_used_variables(v_body)) u
  where u <> all (private.template_variables('broadcast')) order by u limit 1;
  if bad is not null then
    raise exception 'unknown_variable' using detail = bad;
  end if;

  -- Over the shared number a promotion is filtered or reported against every business, so text that
  -- reads like one is refused when this org's broadcasts may go out by SMS at all.
  if private.sms_broadcast_allowed(q.org_id) and private.platform_sms_mode(q.org_id)
     and private.broadcast_promo_like(v_body) then
    raise exception 'invalid_input' using detail = 'promotional';
  end if;

  select * into claim from private.claim_idempotent(q.org_id, 'send_queue_message', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.broadcast_result, claim.response);
  end if;
  -- One sender at a time per queue, so concurrent calls cannot all see 5 and pass the cap.
  perform pg_advisory_xact_lock(hashtextextended(q.id::text, 0));
  if (select count(*) from app.queue_broadcasts x
      where x.queue_id = q.id and x.created_at > now() - interval '1 hour') >= 6 then
    raise exception 'rate_limited';
  end if;

  insert into app.queue_broadcasts (org_id, queue_id, body, sent_by)
  values (q.org_id, q.id, v_body, uid)
  returning * into b;

  for w in
    select * from app.visits x
    where x.queue_id = q.id and x.service_day = private.service_day(q.location_id)
      and x.status in ('waiting', 'called')
    order by x.sort_key, x.id
  loop
    select * into eta from private.visit_eta(w.id);
    vars := jsonb_build_object('message',
      regexp_replace(regexp_replace(v_body, '\{\{\s*ticket\s*\}\}', w.display_ticket, 'g'),
                     '\{\{\s*eta_range\s*\}\}',
                     coalesce(eta.eta_low || '–' || eta.eta_high || ' min', 'a few minutes'), 'g'));
    perform private.enqueue_notification(w, null, 'broadcast', 'broadcast:' || b.id, vars);
    if exists (select 1 from app.notifications nn
               where nn.visit_id = w.id and nn.dedupe_key like 'broadcast:' || b.id || ':%') then
      n_recipients := n_recipients + 1;
    else
      n_suppressed := n_suppressed + 1;
    end if;
  end loop;

  update app.queue_broadcasts set recipients = n_recipients, suppressed = n_suppressed where id = b.id;
  result := (b.id, n_recipients, n_suppressed);
  perform private.save_idempotent('send_queue_message', p_idempotency_key, to_jsonb(result));
  return result;
end $$;

