import { describe, expect, it } from 'vitest';
import { consentText, sha256Hex } from './consent.ts';

describe('consentText', () => {
  it('hashes the same text the database renders (private.render_consent_text)', async () => {
    const r = consentText('sms', 'en', { name: 'Demo Barber', contact: 'help@demo.test' });
    expect(r?.version).toBe(2);
    expect(r?.text).toContain('Demo Barber will text you only about this visit');
    expect(r?.text).toContain('Msg frequency varies. Msg & data rates may apply. Reply STOP');
    expect(r?.text).not.toContain('{{');
    // sha256 computed in Postgres over the same body, name and contact.
    expect(await sha256Hex(r!.text)).toBe(
      'b2507ea8b4be65392acee9862b509b6be517e09de46bbbb6a5846befb6de55b3',
    );
  });

  it('has a Spanish text with its own version and keeps the English STOP and HELP keywords', () => {
    const r = consentText('sms', 'es', { name: 'Demo Barber', contact: null });
    expect(r?.version).toBe(1);
    expect(r?.text).toContain('La frecuencia de mensajes varía.');
    expect(r?.text).toContain('Responde STOP para cancelar, HELP para ayuda');
  });

  it('falls back to the name when there is no contact', () => {
    const r = consentText('whatsapp', 'en', { name: 'Demo Barber', contact: null });
    expect(r?.text).toContain('Questions: Demo Barber.');
  });

  it('returns null for a locale with no published text', () => {
    expect(consentText('sms', 'xx', { name: 'A', contact: null })).toBeNull();
  });
});
