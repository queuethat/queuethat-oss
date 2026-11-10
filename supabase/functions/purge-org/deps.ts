// 2P-PRV8 (#195): the Supabase side of purge-org, built from whichever supabase-js the runtime has.
import { NotDueError, type PurgeOrgDeps } from './handler.ts';

/** The slice of supabase-js `createClient` this file uses. */
// deno-lint-ignore no-explicit-any
type CreateClient = (url: string, key: string, options: any) => any;

export function supabaseDeps(
  createClient: CreateClient,
  env: { url: string; serviceRoleKey: string },
): Omit<PurgeOrgDeps, 'secret' | 'log'> {
  const admin = createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const api = admin.schema('api');

  /** Every object path below prefix; storage lists one level at a time, folders have no id. */
  async function listAll(bucket: string, prefix: string): Promise<string[]> {
    const out: string[] = [];
    const queue = [prefix];
    while (queue.length) {
      const dir = queue.pop()!;
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await admin.storage.from(bucket).list(dir, { limit: 1000, offset });
        if (error) throw new Error(error.message);
        for (const item of data ?? []) {
          if (item.id) out.push(`${dir}/${item.name}`);
          else queue.push(`${dir}/${item.name}`);
        }
        if ((data?.length ?? 0) < 1000) break;
      }
    }
    return out;
  }

  return {
    async targets(orgId) {
      const { data, error } = await api.rpc('org_purge_targets', { p_org_id: orgId });
      if (error?.message === 'not_found') throw new NotDueError();
      if (error) throw new Error(error.message);
      return (data ?? []) as string[];
    },
    async deleteUser(userId) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      // A user that is already gone is a finished job (the function is retried daily).
      if (error && !/not.?found/i.test(error.message)) throw new Error(error.message);
    },
    async buckets() {
      const { data, error } = await admin.storage.listBuckets();
      if (error) throw new Error(error.message);
      return (data ?? []).map((b: { id: string }) => b.id);
    },
    listObjects: listAll,
    async removeObjects(bucket, paths) {
      const { error } = await admin.storage.from(bucket).remove(paths);
      if (error) throw new Error(error.message);
    },
    async markDone(orgId) {
      const { error } = await api.rpc('mark_org_purged_externally', { p_org_id: orgId });
      if (error) throw new Error(error.message);
    },
  };
}
