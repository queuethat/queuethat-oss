-- C1 (#1227, compliance review M6/M10): honour free-text opt-outs and stop treating YES as a re-subscribe.
-- Expand-only: two function bodies change, no table does.
--   * private.inbound_optout_phrase: the whole message (accents folded, apostrophes dropped, punctuation and a leading or
--     trailing "please" dropped) is a stop-like phrase. Never a bare "no", never a phrase inside a longer text.
--   * private.inbound_keyword_kind: such a message is an 'optout', so every inbound route that applies keywords
--     (BYO Twilio, Telnyx, Plivo, Vonage, WhatsApp) suppresses it. YES no longer lifts a STOP.
-- The word lists equal packages/domain/src/sms/keywords.ts (tests/docs/sms-words-drift.test.ts).

create function private.inbound_optout_phrase(p_body text) returns boolean
language sql immutable set search_path = '' as $$
  select regexp_replace(regexp_replace(btrim(regexp_replace(
           translate(lower(coalesce(p_body, '')), 'áéíóúñü’''', 'aeiounu'), '[^a-z0-9]+', ' ', 'g')),
           '^(please|por favor) ', ''), ' (please|por favor|thanks|thank you|gracias)$', '')
         = any (array[
           'stop', 'stop it', 'stop texting', 'stop texting me', 'stop messaging', 'stop messaging me',
           'stop sending texts', 'stop sending me texts', 'stop sending messages', 'stop sending me messages',
           'remove me', 'remove my number', 'remove me from the list', 'remove me from your list',
           'unsubscribe me', 'do not text me', 'dont text me', 'do not message me', 'dont message me',
           'no more texts', 'no more messages', 'take me off', 'take me off the list',
           'take me off your list', 'opt me out',
           'pare', 'paren', 'baja', 'de baja', 'dame de baja', 'darme de baja', 'no mas', 'no mas mensajes',
           'no mas textos', 'no me escriban mas', 'no me envien mas mensajes', 'deja de escribirme',
           'dejen de escribirme', 'dejen de enviarme mensajes'])
$$;
comment on function private.inbound_optout_phrase(text) is
  'True when the whole message, lowercased with Spanish accents folded, apostrophes dropped, punctuation collapsed and a leading '
  'or trailing please / por favor / thanks / gracias removed, is one of the stop-like phrases ("stop texting me", '
  '"remove me", "no mas", "baja"...). A bare "no" or a phrase inside a longer text is not.';

-- redefines private.inbound_keyword_kind from 20261030214739_inbound_keywords.sql
create or replace function private.inbound_keyword_kind(p_body text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(
    (select k.kind
     from (values
       ('optout'::text, array['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT']),
       ('optin'::text, array['START', 'UNSTOP']),
       ('help'::text, array['HELP', 'INFO'])
     ) as k(kind, words)
     where upper(regexp_replace(coalesce(p_body, ''), '[^A-Za-z0-9]', '', 'g')) = any (k.words)),
    case when private.inbound_optout_phrase(p_body) then 'optout' end)
$$;
comment on function private.inbound_keyword_kind(text) is
  'optout, optin or help when the whole message, uppercased with everything but letters and digits '
  'dropped, is a carrier keyword, or optout when it is a free-text opt-out (inbound_optout_phrase); null otherwise. '
  'YES is not an opt-in.';
grant execute on function private.inbound_optout_phrase(text) to public;

-- redefines private.valid_sms_keyword from 20261030222521_sms_join.sql
-- YES stays reserved: a platform-number YES confirms a staff-typed number, so no queue may claim it.
create or replace function private.valid_sms_keyword(p_keyword text) returns boolean
language sql immutable set search_path = '' as $$
  select p_keyword ~ '^[A-Za-z0-9]{2,20}$'
     and private.inbound_keyword_kind(p_keyword) is null
     and private.inbound_command_kind(p_keyword) is null
     and upper(p_keyword) not in ('JOIN', 'YES')
$$;
