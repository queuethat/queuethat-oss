-- #479 follow-up: proton.me, protonmail.com, protonmail.ch and pm.me deliver a username to the
-- same Proton inbox, so they count as one address for the daily cap, per-org dedupe, bounce and
-- stop suppressions and the block list. Local-part separators are left alone (Proton's own rules
-- vary by account), only the domain is folded.
-- redefines private.canonical_email from 20261025004600_mail_abuse_limits.sql

create or replace function private.canonical_email(p_value text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text := nullif(lower(btrim(p_value)), '');
  v_local text;
  v_domain text;
begin
  if v is null or v !~ '^[^@]+@[^@]+$' then
    return v;
  end if;
  v_local := split_part(v, '@', 1);
  v_domain := rtrim(split_part(v, '@', 2), '.');
  -- A local part that is only a tag, or only dots, is kept whole rather than left empty.
  v_local := coalesce(nullif(split_part(v_local, '+', 1), ''), v_local);
  if v_domain in ('gmail.com', 'googlemail.com') then
    v_domain := 'gmail.com';
    v_local := coalesce(nullif(replace(v_local, '.', ''), ''), v_local);
  elsif v_domain in ('proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me') then
    v_domain := 'proton.me';
  end if;
  return v_local || '@' || v_domain;
end $$;
comment on function private.canonical_email(text) is
  'The inbox an email reaches, for matching only (never as a delivery address): trimmed and '
  'lowercased, no +tag in the local part, no trailing dots on the domain, for gmail.com and '
  'googlemail.com no local-part dots and gmail.com, and proton.me for protonmail.com, protonmail.ch '
  'and pm.me. A value that is not one local@domain (a phone, say) comes back trimmed and lowercased. '
  'The one canonical form for abuse limits and blocks (contact_block_hash, #465), so they cannot drift.';

-- Expression indexes over an immutable function keep the old results until rebuilt.
reindex index app.suppressions_key_idx;
reindex index app.visits_live_email_idx;
