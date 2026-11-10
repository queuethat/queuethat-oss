import { DEMO_PASSWORD, demoUsers } from '../../fixtures/demo.ts';

export type TestUserRole = 'owner' | 'staff';

function fromEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} (a test account in the pilot shop).`);
  return value;
}

/**
 * The accounts `signIn` uses, one per role. Locally the demo seed
 * (supabase/seeds/10_demo_org.sql, S6 #27) creates them with their memberships and
 * `tests/fixtures/demo.ts` owns the credentials. Against the pilot (`pnpm test:e2e:pilot`) they
 * are two test accounts of the shop, from PILOT_OWNER_* and PILOT_STAFF_*.
 */
export const testUsers: Record<TestUserRole, { email: string; password: string }> =
  process.env.E2E_PILOT === '1'
    ? {
        owner: { email: fromEnv('PILOT_OWNER_EMAIL'), password: fromEnv('PILOT_OWNER_PASSWORD') },
        staff: { email: fromEnv('PILOT_STAFF_EMAIL'), password: fromEnv('PILOT_STAFF_PASSWORD') },
      }
    : {
        owner: { email: demoUsers.e2eOwner.email, password: DEMO_PASSWORD },
        staff: { email: demoUsers.e2eStaff.email, password: DEMO_PASSWORD },
      };
