import { Button, Checkbox, Select } from '@qm/ui';
import i18next from '../../../lib/i18n.ts';
import { useEffect, useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { browserSpeaker, type VoicePref } from '../../display/announce/announce.ts';
import type { LocationSettings } from './api.ts';

/** Languages a call can be announced in; the database accepts the same five. */
export const ANNOUNCE_LOCALES = ['en', 'es', 'fr', 'de', 'pt'] as const;
const MAX_LOCALES = 4;
const RATES = [0.8, 1, 1.2] as const;

type Announce = Pick<LocationSettings, 'announceLocales' | 'announceVoicePrefs' | 'announceRepeat'>;

/** This browser's voices. They load late in some browsers, hence the event. */
function useVoices() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const synth = globalThis.speechSynthesis;
    if (!synth) return;
    const read = () => setVoices(synth.getVoices());
    read();
    synth.addEventListener?.('voiceschanged', read);
    return () => synth.removeEventListener?.('voiceschanged', read);
  }, []);
  return voices;
}

/**
 * Which languages the waiting-room display announces calls in, the voice and speed for each, and
 * how often the whole call repeats (2B-D7). Voices are the ones of the device you are configuring
 * from; a display that lacks a chosen voice uses its own voice for that language.
 */
export function AnnounceSettings({
  value,
  readOnly,
  onChange,
}: {
  value: Announce;
  readOnly: boolean;
  onChange: (next: Announce) => void;
}) {
  const { t } = useTranslation('admin');
  const voices = useVoices();
  const [testing, setTesting] = useState(false);

  const toggle = (locale: string, on: boolean) => {
    const locales = on
      ? [...value.announceLocales, locale]
      : value.announceLocales.filter((l) => l !== locale);
    onChange({ ...value, announceLocales: locales });
  };
  const setPref = (locale: string, patch: VoicePref) => {
    const merged = { ...value.announceVoicePrefs[locale], ...patch };
    const clean: VoicePref = {};
    if (merged.voice) clean.voice = merged.voice;
    if (merged.rate && merged.rate !== 1) clean.rate = merged.rate;
    const prefs = { ...value.announceVoicePrefs };
    if (Object.keys(clean).length > 0) prefs[locale] = clean;
    else delete prefs[locale];
    onChange({ ...value, announceVoicePrefs: prefs });
  };

  const test = async () => {
    setTesting(true);
    try {
      const speaker = browserSpeaker();
      speaker.unlock();
      await i18next.reloadResources([...new Set(['en', ...value.announceLocales])], 'announce');
      for (const lang of value.announceLocales) {
        const pref = value.announceVoicePrefs[lang];
        await speaker.speak(i18next.getFixedT(lang, 'announce')('test'), lang, pref);
      }
    } finally {
      setTesting(false);
    }
  };

  return (
    <fieldset className="flex flex-col gap-3" data-testid="announce-settings">
      <legend className="text-lg font-semibold">{t('location.announce.title')}</legend>
      <p className="text-muted">{t('location.announce.hint')}</p>
      {ANNOUNCE_LOCALES.map((locale) => {
        const on = value.announceLocales.includes(locale);
        const pref = value.announceVoicePrefs[locale];
        const own = voices.filter((v) => v.lang.toLowerCase().startsWith(locale));
        return (
          <div key={locale} className="flex flex-wrap items-end gap-3">
            <Checkbox
              label={t(`location.announce.locale.${locale}`)}
              checked={on}
              disabled={
                readOnly ||
                (on && value.announceLocales.length === 1) ||
                (!on && value.announceLocales.length >= MAX_LOCALES)
              }
              onChange={(event) => toggle(locale, event.target.checked)}
            />
            {on ? (
              <>
                <Select
                  label={t('location.announce.voice')}
                  value={pref?.voice ?? ''}
                  disabled={readOnly}
                  onChange={(event) => setPref(locale, { voice: event.target.value })}
                >
                  <option value="">{t('location.announce.defaultVoice')}</option>
                  {pref?.voice && !own.some((v) => v.name === pref.voice) ? (
                    <option value={pref.voice}>{pref.voice}</option>
                  ) : null}
                  {own.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name}
                    </option>
                  ))}
                </Select>
                <Select
                  label={t('location.announce.speed')}
                  value={String(pref?.rate ?? 1)}
                  disabled={readOnly}
                  onChange={(event) => setPref(locale, { rate: Number(event.target.value) })}
                >
                  {RATES.map((rate) => (
                    <option key={rate} value={rate}>
                      {t(
                        `location.announce.rate.${rate === 0.8 ? 'slow' : rate === 1 ? 'normal' : 'fast'}`,
                      )}
                    </option>
                  ))}
                </Select>
              </>
            ) : null}
          </div>
        );
      })}
      <Select
        label={t('location.announce.repeat')}
        value={String(value.announceRepeat)}
        disabled={readOnly}
        onChange={(event) => onChange({ ...value, announceRepeat: Number(event.target.value) })}
      >
        {[1, 2, 3].map((n) => (
          <option key={n} value={n}>
            {t('location.announce.times', { count: n })}
          </option>
        ))}
      </Select>
      <div>
        <Button
          variant="secondary"
          onClick={() => void test()}
          loading={testing}
          loadingLabel={t('location.announce.testing')}
        >
          {t('location.announce.test')}
        </Button>
      </div>
    </fieldset>
  );
}
