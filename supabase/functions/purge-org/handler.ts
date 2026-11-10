// 2P-PRV8 (#195): purge-org removes what the SQL purge cannot reach: an org's device auth users
// and every storage object under `{org_id}/` in every bucket. The service role is used only here
// (technical-design.md 5). ops.purge_deleted_orgs calls it through pg_net once an org's deletion
// date has passed, and deletes the org's rows only after this function reported back.
//
// POST { org_id } with Authorization: Bearer <DISPATCH_SECRET> (the vault secret dispatcher_key).
//   200 { users, objects }   done and reported to the database; safe to repeat
//   400 { error: "invalid_input" }
//   403 { error: "forbidden" }   anything but the secret: a user JWT, the anon key, no header
//   404 { error: "not_found" }   the org is not past its deletion date (the database says so)
//   405 anything but POST
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PurgeOrgDeps {
  /** DISPATCH_SECRET; shorter than 32 characters means nobody may call. */
  secret: string;
  /** Device auth user ids of the org; throws NotDueError unless the deletion date has passed. */
  targets(orgId: string): Promise<string[]>;
  deleteUser(userId: string): Promise<void>;
  buckets(): Promise<string[]>;
  /** Object paths under prefix, folders expanded. */
  listObjects(bucket: string, prefix: string): Promise<string[]>;
  removeObjects(bucket: string, paths: string[]): Promise<void>;
  markDone(orgId: string): Promise<void>;
  log(line: string): void;
}

export class NotDueError extends Error {}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sameKey(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function createPurgeOrgHandler(deps: PurgeOrgDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const auth = req.headers.get('Authorization') ?? '';
    if (deps.secret.length < 32 || !sameKey(auth, `Bearer ${deps.secret}`)) {
      return json(403, { error: 'forbidden' });
    }
    const body = (await req.json().catch(() => null)) as { org_id?: unknown } | null;
    const orgId = typeof body?.org_id === 'string' ? body.org_id : '';
    if (!UUID.test(orgId)) return json(400, { error: 'invalid_input' });

    let userIds: string[];
    try {
      userIds = await deps.targets(orgId);
    } catch (e) {
      if (e instanceof NotDueError) return json(404, { error: 'not_found' });
      throw e;
    }
    for (const id of userIds) await deps.deleteUser(id);

    // Only this org's prefix is ever listed or removed, so another org's objects are out of reach.
    let objects = 0;
    for (const bucket of await deps.buckets()) {
      const paths = await deps.listObjects(bucket, orgId);
      for (let i = 0; i < paths.length; i += 100) {
        await deps.removeObjects(bucket, paths.slice(i, i + 100));
      }
      objects += paths.length;
    }
    await deps.markDone(orgId);
    deps.log(`purged org: ${userIds.length} users, ${objects} objects`);
    return json(200, { users: userIds.length, objects });
  };
}
