import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { expect, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { newCode, pair, servePairDevice } from './support/pairing.ts';
import { freshQueue } from './support/queues.ts';
import { testUsers } from './support/users.ts';

// 2B-D7 (#264): the display announces each call in every configured language. speechSynthesis is a
// recorder, so the spec checks what would be spoken and with which voice, not the audio.

const env = supabaseEnv();
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(env.url, env.serviceRoleKey, noSession);

// The demo location is shared, so these tests run one after the other and restore it.
test.describe.configure({ mode: 'serial' });
test.afterEach(async () => {
  await service
    .schema('app')
    .from('locations')
    .update({ announce_locales: ['en'], announce_voice_prefs: {}, announce_repeat: 1 })
    .eq('id', demo.locationId);
});

test('AC1: with English and French configured, a call is spoken in English then French', async ({
  devices,
}) => {
  const { display } = devices;
  const { error } = await service
    .schema('app')
    .from('locations')
    .update({ announce_locales: ['en', 'fr'], announce_voice_prefs: { fr: { rate: 1.2 } } })
    .eq('id', demo.locationId);
  expect(error).toBeNull();
  await display.addInitScript(() => {
    const spoken: Array<{ text: string; lang: string; rate: number }> = [];
    (window as unknown as { spoken: typeof spoken }).spoken = spoken;
    (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
      lang = '';
      rate = 1;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    };
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => [],
        speak: (u: { text: string; lang: string; rate: number; onend: () => void }) => {
          if (u.text) spoken.push({ text: u.text, lang: u.lang, rate: u.rate });
          setTimeout(() => u.onend?.(), 10);
        },
        cancel: () => {},
      },
    });
    localStorage.setItem('qm:display:sound', 'chime-speech');
  });
  await servePairDevice(display);
  await display.goto('/display');
  await pair(display, await newCode('display'));
  await expect(display.getByRole('heading', { name: 'Now serving' })).toBeVisible();
  await display.getByRole('button', { name: 'Tap to enable sound' }).click();
  await expect(display.getByTestId('reconnecting')).toHaveCount(0);

  const queue = await freshQueue();
  const anon = createClient(env.url, env.anonKey, noSession).schema('api');
  const joined = await anon.rpc('join_queue', {
    p_queue_id: queue.id,
    p_service_id: null,
    p_name: 'Sam Rivera',
    p_phone_e164: null,
    p_email: null,
    p_party_size: 1,
    p_locale: 'en',
    p_idempotency_key: randomUUID(),
  });
  expect(joined.error).toBeNull();
  const staff = createClient(env.url, env.anonKey, noSession);
  await staff.auth.signInWithPassword(testUsers.staff);
  const called = await staff.schema('api').rpc('call_next', {
    p_queue_id: queue.id,
    p_counter_id: demo.counters.chair1,
    p_idempotency_key: randomUUID(),
  });
  expect(called.error).toBeNull();

  await expect
    .poll(() => display.evaluate(() => (window as unknown as { spoken: unknown[] }).spoken), {
      timeout: 8_000,
    })
    .toEqual([
      expect.objectContaining({ lang: 'en', text: expect.stringMatching(/^Ticket .* Chair 1$/) }),
      expect.objectContaining({
        lang: 'fr',
        rate: 1.2,
        text: expect.stringMatching(/^Ticket .* Chair 1$/),
      }),
    ]);
});

test.describe('as an owner', () => {
  test.use({ staffUser: 'owner' });

  test('an owner picks the languages in location settings and they reach the database', async ({
    devices,
  }) => {
    const { staff } = devices;
    await staff.goto('/admin/location');
    const section = staff.getByTestId('announce-settings');
    await section.getByLabel('French').check();
    await section.getByLabel('Repeat each call').selectOption('2');
    await staff.getByRole('button', { name: 'Save settings' }).click();
    await expect
      .poll(async () => {
        const { data } = await service
          .schema('app')
          .from('locations')
          .select('announce_locales, announce_repeat')
          .eq('id', demo.locationId)
          .single();
        return data;
      })
      .toEqual({ announce_locales: ['en', 'fr'], announce_repeat: 2 });
  });
});
