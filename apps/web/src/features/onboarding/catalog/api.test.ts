import { describe, expect, it } from 'vitest';
import { catalogText, rankCatalog, toEntry } from './api.ts';

const v1 = (key: string, name: string, description: string, service: string) =>
  toEntry(
    {
      key,
      version: 1,
      tier: 2,
      health_tagged: false,
      payload: {
        name,
        description,
        queues: [{ name: 'Walk-ins', show_eta: true, services: [{ name: service, minutes: 10 }] }],
      },
    },
    'en',
  );

const barberV2 = {
  key: 'barber',
  version: 2,
  tier: 1,
  health_tagged: false,
  payload: {
    name: { en: 'Barber', es: 'Barbería' },
    description: { en: 'Cuts', es: 'Cortes' },
    keywords: { en: ['fade'], es: ['corte'] },
    queues: [
      {
        name: { en: 'Walk-ins', es: 'Sin cita' },
        show_eta: true,
        services: [{ name: { en: 'Haircut', es: 'Corte' }, minutes: 30 }],
      },
    ],
    form: {
      name: { en: 'Visit', es: 'Visita' },
      fields: [
        { key: 'style', type: 'short_text', label: { en: 'Style', es: 'Estilo' } },
        { key: 'h', type: 'heading', label: { en: 'More', es: 'Más' } },
        { key: 'ok', type: 'agreement', label: { en: 'Terms', es: 'Términos' }, required: true },
      ],
    },
  },
};

describe('catalogText', () => {
  it('reads plain v1 text and localized text, falling back to English', () => {
    expect(catalogText('Clinic', 'es')).toBe('Clinic');
    expect(catalogText({ en: 'Barber', es: 'Barbería' }, 'es-MX')).toBe('Barbería');
    expect(catalogText({ en: 'Barber', es: 'Barbería' }, 'de')).toBe('Barber');
  });
});

describe('toEntry', () => {
  it('reads a T2 payload: questions only, the agreement as a waiver, Spanish strings', () => {
    const e = toEntry(barberV2, 'es');
    expect(e).toMatchObject({
      key: 'barber',
      version: 2,
      name: 'Barbería',
      keywords: ['fade', 'corte'],
      queues: [{ name: 'Sin cita', services: [{ name: 'Corte', minutes: 30 }] }],
      questions: [{ label: 'Estilo', required: false }],
      waiver: true,
    });
  });
});

describe('rankCatalog', () => {
  const catalog = [
    v1('clinic', 'Clinic', 'Ticket numbers only', 'Appointment'),
    v1('restaurant', 'Restaurant', 'A waitlist for parties', 'Table'),
    toEntry(barberV2, 'en'),
  ];

  it('recommends from the name, then keywords, then services; prefixes match', () => {
    expect(rankCatalog(catalog, 'barb').map((e) => e.key)).toEqual(['barber']);
    expect(rankCatalog(catalog, "Joe's fade shop").map((e) => e.key)).toEqual(['barber']);
    expect(rankCatalog(catalog, 'table').map((e) => e.key)).toEqual(['restaurant']);
  });

  it('ignores accents and short words, and returns nothing for no match', () => {
    expect(rankCatalog(catalog, 'clínic').map((e) => e.key)).toEqual(['clinic']);
    expect(rankCatalog(catalog, 'a b')).toEqual([]);
    expect(rankCatalog(catalog, 'zoo')).toEqual([]);
  });
});
