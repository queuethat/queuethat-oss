-- 2B-D6 (#263): per-location announcement settings for the waiting-room display.
--
--   announce_locales      languages a call is spoken in, in order (en, es, fr, de, pt)
--   announce_voice_prefs  locale -> {"voice": "<device voice name>", "rate": 0.5..2}
--   announce_repeat       how many times the whole sequence is spoken (1-3)
--
-- Paired devices already read their location row (locations_select), so the display reads these
-- columns directly: api.display_snapshot keeps its return type. Admins write them through the
-- existing locations_update policy; the checks below are the validation. Changing any of them
-- signals the location's boards to refetch, like a rename.

create function private.valid_announce_locales(p_locales text[]) returns boolean
language sql immutable set search_path = '' as $$
  select p_locales is not null
    and cardinality(p_locales) between 1 and 4
    and p_locales <@ array['en', 'es', 'fr', 'de', 'pt']
    and cardinality(p_locales) = (select count(distinct l) from unnest(p_locales) l)
$$;
comment on function private.valid_announce_locales(text[]) is
  'True for 1-4 distinct announcement locales, all from the supported list.';

create function private.valid_announce_voice_prefs(p_prefs jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select p_prefs is not null and jsonb_typeof(p_prefs) = 'object'
    and not exists (
      select 1 from jsonb_each(p_prefs) e
      where e.key <> all (array['en', 'es', 'fr', 'de', 'pt'])
         or jsonb_typeof(e.value) <> 'object'
         or exists (select 1 from jsonb_object_keys(e.value) k where k not in ('voice', 'rate'))
         or (e.value ? 'voice' and (jsonb_typeof(e.value -> 'voice') <> 'string'
                                    or length(e.value ->> 'voice') > 120))
         or (e.value ? 'rate' and (jsonb_typeof(e.value -> 'rate') <> 'number'
                                   or (e.value ->> 'rate')::numeric not between 0.5 and 2))
    )
$$;
comment on function private.valid_announce_voice_prefs(jsonb) is
  'True for an object of supported locale -> {voice: text up to 120, rate: 0.5-2}.';

alter table app.locations
  add column announce_locales text[] not null default '{en}'
    constraint locations_announce_locales_check check (private.valid_announce_locales(announce_locales)),
  add column announce_voice_prefs jsonb not null default '{}'
    constraint locations_announce_voice_prefs_check check (private.valid_announce_voice_prefs(announce_voice_prefs)),
  add column announce_repeat int not null default 1
    constraint locations_announce_repeat_check check (announce_repeat between 1 and 3);

comment on column app.locations.announce_locales is
  'Languages the display speaks a call in, in order. Supported: en, es, fr, de, pt.';
comment on column app.locations.announce_voice_prefs is
  'Per locale {voice, rate}. The voice name is whatever the display device reports; a missing one falls back to the device default.';
comment on column app.locations.announce_repeat is 'Times the whole multilingual call is spoken, 1-3.';

-- Boards refetch when announcement settings change, as they do for a rename.
drop trigger note_display_change on app.locations;
create trigger note_display_change
  after update of name, display_names_enabled, announce_locales, announce_voice_prefs, announce_repeat
  on app.locations
  for each row when (new.name is distinct from old.name
                     or new.display_names_enabled is distinct from old.display_names_enabled
                     or new.announce_locales is distinct from old.announce_locales
                     or new.announce_voice_prefs is distinct from old.announce_voice_prefs
                     or new.announce_repeat is distinct from old.announce_repeat)
  execute function private.note_location_display_change();

-- Check constraints run as the writing role.
grant execute on function private.valid_announce_locales(text[]), private.valid_announce_voice_prefs(jsonb)
  to authenticated, service_role;
