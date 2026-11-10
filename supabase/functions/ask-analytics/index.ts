// ask-analytics entry point. The logic and its contract are in handler.ts. verify_jwt stays on
// (supabase/config.toml); every read of tenant data uses the caller's JWT. The service role is used
// only to read the org's own LLM key from Vault.
import { createClient } from '@supabase/supabase-js';
import { AnthropicLlmProvider, FakeLlmProvider } from '@qm/providers';
import { createObserver } from '../_shared/observe.ts';
import { supabaseDeps } from './deps.ts';
import { createAskHandler } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const observe = createObserver('ask-analytics', Deno.env.get('SENTRY_DSN'));
// Local stack only: LLM_PROVIDER=fake answers every question with a canned definition, so the page
// can be tried without a key. A real org always uses its own key from Vault.
const fake = Deno.env.get('LLM_PROVIDER') === 'fake';

Deno.serve(
  observe.serve(createAskHandler({
    ...supabaseDeps(createClient, {
      url: env('SUPABASE_URL'),
      anonKey: env('SUPABASE_ANON_KEY'),
      serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
    }),
    makeProvider: (config) =>
      fake
        ? new FakeLlmProvider([
          '{"measures": ["visits", "served"], "dimensions": ["weekday"], "days": 28}',
          'Visits and served counts by weekday (local stack, canned reply).',
        ])
        : new AnthropicLlmProvider({ apiKey: config.apiKey, model: config.model }),
    today: () => new Date().toISOString().slice(0, 10),
    publicUrl: env('PUBLIC_URL'),
    error: observe.error,
  })),
);
