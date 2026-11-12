import { describe, expect, it } from 'vitest';
import { lintTemplate, lintWaiver } from './catalog.ts';

const L = (en: string, es = `${en} (es)`) => ({ en, es });
const q = (key: string, required = false) => ({
  key,
  type: 'short_text',
  label: L(key),
  required,
  sensitivity: 'normal',
});
const banner = L(
  'A starting point, not legal advice. Have your own counsel review before using.',
  'Un punto de partida, no es asesoría legal.',
);

function barber(): Record<string, unknown> {
  return {
    key: 'barber',
    version: 2,
    tier: 1,
    mode: 'both',
    health_tagged: false,
    name: L('Barber'),
    description: L('Walk-ins and bookings'),
    keywords: { en: ['haircut', 'fade'], es: ['corte'] },
    queues: [
      {
        name: L('Walk-ins'),
        prefix: 'A',
        show_eta: true,
        services: [{ name: L('Haircut'), minutes: 30 }],
      },
    ],
    resources: [{ label: L('Chair 1'), kind: 'chair' }],
    providers: { noun: L('barber', 'barbero'), default_count: 3, pool: true },
    form: { name: L('Visit'), fields: [q('style'), q('notes'), q('name', true)] },
    booking: { slot_minutes: 30 },
  };
}

describe('lintTemplate', () => {
  it('passes a complete template', () => {
    expect(lintTemplate(barber(), 'barber')).toEqual([]);
  });

  it('AC: fails more than 3 optional questions (required ones and headings do not count)', () => {
    const t = barber();
    t.form = {
      name: L('Visit'),
      fields: [q('a'), q('b'), q('c'), q('d', true), { key: 'h', type: 'heading', label: L('H') }],
    };
    expect(lintTemplate(t)).toEqual([]);
    (t.form as { fields: unknown[] }).fields.push(q('e'));
    expect(lintTemplate(t)).toEqual(['form.fields: 4 optional questions; at most 3']);
  });

  it('AC: fails a missing or blank ES string anywhere', () => {
    const t = barber();
    (t.queues as { services: { name: unknown }[] }[])[0]!.services[0]!.name = { en: 'Haircut' };
    t.description = { en: 'x', es: '  ' };
    t.keywords = { en: ['haircut'] };
    expect(lintTemplate(t)).toEqual([
      'description: missing ES string',
      'keywords.es: missing ES keywords',
      'queues[0].services[0].name: missing ES string',
    ]);
  });

  it('AC: fails a service without a duration', () => {
    const t = barber();
    delete (t.queues as { services: { minutes?: number }[] }[])[0]!.services[0]!.minutes;
    expect(lintTemplate(t)).toEqual([
      'queues[0].services[0].minutes: service needs a duration of 1-480 minutes',
    ]);
  });

  it('AC: fails a health-class vertical without the clinical-safety flags', () => {
    const t = barber();
    t.key = 'dental';
    t.form = {
      name: L('Visit'),
      fields: [
        { key: 'history', type: 'long_text', label: L('History'), sensitivity: 'sensitive' },
        { key: 'reason', type: 'short_text', label: L('Reason') },
      ],
    };
    expect(lintTemplate(t)).toEqual([
      'health_tagged: a health-class vertical must be health_tagged',
      'form.fields[0]: health-class forms take no long_text',
      'form.fields[0]: a sensitive answer in a health-class form must be short_text',
      'form.fields[1].sensitivity: health-class questions declare their sensitivity',
    ]);
    t.health_tagged = true;
    t.form = {
      name: L('Visit'),
      fields: [{ key: 'reason', type: 'short_text', label: L('Reason'), sensitivity: 'sensitive' }],
    };
    expect(lintTemplate(t)).toEqual([]);
  });

  it('AC: fails an agreement without the "not legal advice" banner', () => {
    const t = barber();
    t.form = {
      name: L('Visit'),
      fields: [{ key: 'waiver', type: 'agreement', label: L('Waiver'), body: L('Terms') }],
    };
    expect(lintTemplate(t)).toEqual([
      'waiver_banner: must be {"en": ..., "es": ...}',
      'waiver_banner: a waiver needs the "not legal advice" banner',
    ]);
    t.waiver_banner = L('Legally binding!');
    expect(lintTemplate(t)).toEqual([
      'waiver_banner: a waiver needs the "not legal advice" banner',
    ]);
    t.waiver_banner = banner;
    expect(lintTemplate(t)).toEqual([]);
  });

  it('checks structure: key matches the file, prefixes, choice options, consent never required', () => {
    const t = barber();
    (t.queues as { prefix: string }[])[0]!.prefix = 'a1';
    t.form = {
      name: L('Visit'),
      fields: [
        { key: 'size', type: 'single_choice', label: L('Size') },
        { key: 'mk', type: 'marketing_consent', label: L('News'), required: true },
        { key: 'sig', type: 'signature', label: L('Sign') },
      ],
    };
    expect(lintTemplate(t, 'barber_v2')).toEqual([
      'key: must match the file name "barber_v2"',
      'queues[0].prefix: 1-3 capitals',
      'form.fields[0].options: only and always on choice fields',
      'form.fields[1].required: marketing consent is never required',
      'form.fields: a signature needs an agreement',
    ]);
  });
});

describe('lintWaiver', () => {
  const waiver = () => ({
    key: 'tattoo',
    version: 1,
    name: L('Tattoo release'),
    form: {
      name: L('Release'),
      fields: [
        {
          key: 'release',
          type: 'agreement',
          label: L('Release'),
          body: L('I agree'),
          required: true,
        },
        { key: 'sig', type: 'signature', label: L('Sign'), required: true },
      ],
    },
    waiver_banner: banner,
  });

  it('passes a starter waiver', () => {
    expect(lintWaiver(waiver(), 'tattoo')).toEqual([]);
  });

  it('AC: fails a waiver without the banner or without an agreement', () => {
    const w: Record<string, unknown> = waiver();
    delete w.waiver_banner;
    w.form = { name: L('Release'), fields: [q('x')] };
    expect(lintWaiver(w)).toEqual([
      'form.fields: a waiver needs an agreement',
      'waiver_banner: must be {"en": ..., "es": ...}',
      'waiver_banner: a waiver needs the "not legal advice" banner',
    ]);
  });
});
