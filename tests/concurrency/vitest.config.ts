import { defineConfig } from 'vitest/config';

// V8 (#37): races against the local Supabase database. Not part of `pnpm test`, which runs
// without a database; `scripts/ci-db.sh` runs it after pgTAP.
export default defineConfig({
  test: {
    name: 'concurrency',
    root: import.meta.dirname,
    include: ['*.test.ts'],
    environment: 'node',
    // Each file opens up to ~40 real connections to the local database (max_connections is 100,
    // shared with PostgREST, Realtime and Auth). The races are inside a file, so files run in turn.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
