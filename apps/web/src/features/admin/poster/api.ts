import { queryOptions, useQuery } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import { telegramJoinUrl } from './url.ts';

/** The word and number for the poster's "text to join" line (J-8). */
export interface TextToJoin {
  keyword: string;
  number: string;
}

/**
 * The location's first queue with a text keyword and the org's SMS number, when SMS is enabled.
 * Provider settings are readable only by unrestricted admins (RLS), so anyone else gets no line.
 */
export const textToJoinQuery = (orgId: string, locationId: string) =>
  queryOptions({
    queryKey: ['admin', 'poster', 'text-to-join', orgId, locationId],
    queryFn: async (): Promise<TextToJoin | null> => {
      const app = supabase.schema('app');
      const [queues, sms] = await Promise.all([
        app
          .from('queues')
          .select('sms_keyword')
          .eq('location_id', locationId)
          .is('archived_at', null)
          .not('sms_keyword', 'is', null)
          .order('sort_order')
          .order('name')
          .limit(1),
        app
          .from('provider_settings')
          .select('enabled, config')
          .eq('org_id', orgId)
          .eq('channel', 'sms')
          .maybeSingle(),
      ]);
      if (queues.error) throw queues.error;
      if (sms.error) throw sms.error;
      const keyword = queues.data[0]?.sms_keyword;
      const number = (sms.data?.config as { from_number?: unknown } | undefined)?.from_number;
      return sms.data?.enabled && keyword && typeof number === 'string'
        ? { keyword, number }
        : null;
    },
  });

export const useTextToJoin = (orgId: string | undefined, locationId: string | undefined) =>
  useQuery({ ...textToJoinQuery(orgId ?? '', locationId ?? ''), enabled: !!orgId && !!locationId });

/** The deployment's Telegram bot username, or null when none is configured (api.get_telegram_bot). */
export const telegramBotQuery = () =>
  queryOptions({
    queryKey: ['admin', 'poster', 'telegram-bot'],
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase.schema('api').rpc('get_telegram_bot');
      if (error) throw error;
      return data;
    },
  });

/** The queues a Telegram link could name: one start payload per location, see telegramStartPayload. */
export const posterQueuesQuery = (locationId: string) =>
  queryOptions({
    queryKey: ['admin', 'poster', 'queues', locationId],
    queryFn: async (): Promise<Array<{ sms_keyword: string | null }>> => {
      const { data, error } = await supabase
        .schema('app')
        .from('queues')
        .select('sms_keyword')
        .eq('location_id', locationId)
        .is('archived_at', null)
        .order('sort_order')
        .order('name');
      if (error) throw error;
      return data;
    },
  });

export const useTelegramLink = (slug: string | undefined, locationId: string | undefined) => {
  const bot = useQuery(telegramBotQuery()).data;
  const queues = useQuery({
    ...posterQueuesQuery(locationId ?? ''),
    enabled: !!locationId && !!bot,
  }).data;
  return bot && slug && queues ? telegramJoinUrl(bot, slug, queues) : null;
};
