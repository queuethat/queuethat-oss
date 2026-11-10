// I-1 (#310): writes docs/api/openapi-v1.json from the running PostgREST: `pnpm openapi:v1`
// (local Supabase must be up). `--check` exits 1 when the committed file is stale. The host,
// port and PostgREST version are dropped so the file only changes when the API does.
import { readFileSync, writeFileSync } from 'node:fs';

const API_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:55321';
// The public (publishable) key every client already ships; it only lets PostgREST answer.
const KEY = process.env.SUPABASE_ANON_KEY ?? 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const OUT = new URL('../docs/api/openapi-v1.json', import.meta.url);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function sorted(value: Json): Json {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted((value as { [key: string]: Json })[key]!)]),
    );
  }
  return value;
}

const response = await fetch(`${API_URL}/rest/v1/`, {
  headers: { apikey: KEY, 'Accept-Profile': 'api_v1' },
});
if (!response.ok) throw new Error(`PostgREST answered ${response.status}`);
const spec = (await response.json()) as { [key: string]: Json };
delete spec.host;
delete spec.schemes;
(spec.info as { [key: string]: Json }).version = 'v1';
(spec.info as { [key: string]: Json }).title = 'Queue management API v1';
const text = `${JSON.stringify(sorted(spec), null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('docs/api/openapi-v1.json is stale: run `pnpm openapi:v1` and commit it.');
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
