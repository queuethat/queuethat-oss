// 2A-TM1 (#95): the Supabase side of invite-staff, built from whichever supabase-js the runtime
// has (index.ts passes Deno's npm import).
import { DbError, type Invitation, type InviteContext, type InviteStaffDeps } from './handler.ts';

/** The slice of supabase-js `createClient` this file uses. */
// deno-lint-ignore no-explicit-any
type CreateClient = (url: string, key: string, options: any) => any;

export function supabaseDeps(
  createClient: CreateClient,
  env: { url: string; serviceRoleKey: string; anonKey: string; siteUrl: string },
): Omit<InviteStaffDeps, 'log'> {
  const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(env.url, env.serviceRoleKey, noSession);
  // The caller's own JWT: has_role-style checks in the RPC see them, not the service role.
  const asCaller = (jwt: string) =>
    createClient(env.url, env.anonKey, {
      ...noSession,
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    }).schema('api');

  return {
    siteUrl: env.siteUrl,
    async createInvitation(jwt, input) {
      const { data, error } = await asCaller(jwt).rpc('create_invitation', {
        p_org_id: input.org_id,
        p_email: input.email,
        p_role: input.role,
        p_location_ids: input.location_ids,
        p_display_name: input.display_name,
        p_idempotency_key: input.idempotency_key,
      });
      // PostgREST reports a rejected JWT as 401 before any SQL runs.
      if (error) throw new DbError(error.message === 'JWT expired' ? 'not_authenticated' : error.message, error.details);
      return data as Invitation;
    },
    async revokeInvitation(jwt, id) {
      const { error } = await asCaller(jwt).rpc('revoke_invitation', {
        p_invitation_id: id,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(error.message);
    },
    async inviteContext(jwt, orgId): Promise<InviteContext> {
      // As the caller: RLS lets a member read their own organization and membership.
      const db = createClient(env.url, env.anonKey, {
        ...noSession,
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      });
      const { data: user } = await db.auth.getUser(jwt);
      const [org, member] = await Promise.all([
        db.schema('app').from('organizations').select('name').eq('id', orgId).maybeSingle(),
        db
          .schema('app')
          .from('memberships')
          .select('display_name')
          .eq('org_id', orgId)
          .eq('user_id', user?.user?.id ?? '')
          .maybeSingle(),
      ]);
      return {
        orgName: org.data?.name ?? null,
        inviterName: member.data?.display_name ?? null,
      };
    },
    async sendInvite(email, redirectTo, displayName, context) {
      // The templates read these from the user's metadata (`.Data`); accepting the invitation
      // clears them again (see useAcceptInvitation).
      const invite = { invite_org: context.orgName, invite_by: context.inviterName };
      const invited = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo,
        data: { ...(displayName ? { display_name: displayName } : {}), ...invite },
      });
      if (!invited.error) return;
      if (invited.error.code !== 'email_exists') throw new Error(invited.error.message);
      // Already has an account: note the invitation on it, then a magic link signs them in and
      // lands on the same page. supabase-js can't look a user up by email, so ask the Auth admin
      // API's `filter` (a substring search), then match the address exactly.
      const response = await fetch(
        `${env.url}/auth/v1/admin/users?per_page=10&filter=${encodeURIComponent(email)}`,
        { headers: { apikey: env.serviceRoleKey, Authorization: `Bearer ${env.serviceRoleKey}` } },
      );
      if (!response.ok) throw new Error(`user lookup failed: ${response.status}`);
      const { users } = (await response.json()) as {
        users: { id: string; email: string; user_metadata: Record<string, unknown> }[];
      };
      const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
      if (!user) throw new Error('user lookup found nobody');
      const updated = await admin.auth.admin.updateUserById(user.id, {
        user_metadata: { ...user.user_metadata, ...invite },
      });
      if (updated.error) throw new Error(updated.error.message);
      const client = createClient(env.url, env.anonKey, noSession);
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
      });
      if (error) throw new Error(error.message);
    },
  };
}
