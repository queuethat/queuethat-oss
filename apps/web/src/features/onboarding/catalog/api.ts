import { queryOptions } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

/** A catalog string: `{en, es}` from T2-linted content, or plain text in the older v1 rows. */
type CatalogText = string | { en?: string; es?: string } | null | undefined;

export interface CatalogService {
  name: string;
  minutes: number | null;
}
export interface CatalogQueue {
  name: string;
  showEta: boolean;
  services: CatalogService[];
}
export interface CatalogQuestion {
  label: string;
  required: boolean;
}

/** One catalog template, newest version, with its strings in the reader's language. */
export interface CatalogEntry {
  key: string;
  version: number;
  name: string;
  description: string;
  tier: number;
  healthTagged: boolean;
  keywords: string[];
  queues: CatalogQueue[];
  questions: CatalogQuestion[];
  waiver: boolean;
  /** Templates for several providers ask "How many doctors?" (T4); null for one shared line. */
  providers: { noun: string; defaultCount: number; pool: boolean } | null;
}

/** The text for `lang` (English when the catalog has none in that language). */
export function catalogText(value: CatalogText, lang: string): string {
  if (typeof value === 'string') return value;
  if (!value) return '';
  return (lang.startsWith('es') ? value.es : undefined) ?? value.en ?? '';
}

type Json = Record<string, unknown>;
const list = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const QUESTION_TYPES = new Set([
  'short_text',
  'long_text',
  'single_choice',
  'multi_choice',
  'yes_no',
  'number',
  'date',
  'phone',
  'email',
]);

/** Reads one `api.list_template_catalog` row into what the picker and preview render. */
export function toEntry(row: Json, lang: string): CatalogEntry {
  const payload = (row.payload ?? {}) as Json;
  const text = (v: unknown) => catalogText(v as CatalogText, lang);
  const keywords = payload.keywords as { en?: string[]; es?: string[] } | undefined;
  const fields = list((payload.form as Json | undefined)?.fields);
  const providers = payload.providers as Json | undefined;
  return {
    key: row.key as string,
    version: row.version as number,
    name: text(payload.name),
    description: text(payload.description),
    tier: row.tier as number,
    healthTagged: !!row.health_tagged,
    keywords: [...(keywords?.en ?? []), ...(lang.startsWith('es') ? (keywords?.es ?? []) : [])],
    queues: list(payload.queues).map((q) => ({
      name: text(q.name),
      showEta: q.show_eta !== false,
      services: list(q.services).map((s) => ({
        name: text(s.name),
        minutes: typeof s.minutes === 'number' ? s.minutes : null,
      })),
    })),
    questions: fields
      .filter((f) => QUESTION_TYPES.has(f.type as string))
      .map((f) => ({ label: text(f.label), required: f.required === true })),
    waiver: fields.some((f) => f.type === 'agreement'),
    providers: providers
      ? {
          noun: text(providers.noun),
          defaultCount: typeof providers.default_count === 'number' ? providers.default_count : 1,
          pool: providers.pool === true,
        }
      : null,
  };
}

/** The template catalog (api.list_template_catalog), tier 1 first, in the reader's language. */
export const catalogQuery = (lang: string) =>
  queryOptions({
    queryKey: ['onboarding', 'catalog', lang.startsWith('es') ? 'es' : 'en'],
    staleTime: Infinity,
    queryFn: async (): Promise<CatalogEntry[]> => {
      const { data, error } = await supabase.rpc('list_template_catalog');
      if (error) throw error;
      return data.map((row) => toEntry(row as Json, lang));
    },
  });

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
const words = (s: string) =>
  fold(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * Templates ranked for a search (or the business name), best first; those that match nothing are
 * dropped. A word in the template's name counts most, then keywords, then descriptions and services.
 * Prefixes match, so "barb" finds Barber.
 */
export function rankCatalog(entries: CatalogEntry[], query: string): CatalogEntry[] {
  const terms = words(query).filter((w) => w.length >= 3);
  if (!terms.length) return [];
  const scored = entries.map((e) => {
    const name = words(e.name);
    const keywords = e.keywords.flatMap(words);
    const rest = [
      ...words(e.description),
      ...e.queues.flatMap((q) => [...words(q.name), ...q.services.flatMap((s) => words(s.name))]),
    ];
    const hit = (pool: string[], t: string) => pool.some((w) => w.startsWith(t));
    const score = terms.reduce(
      (sum, t) => sum + (hit(name, t) ? 3 : hit(keywords, t) ? 2 : hit(rest, t) ? 1 : 0),
      0,
    );
    return { e, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.e.tier - b.e.tier)
    .map((s) => s.e);
}
