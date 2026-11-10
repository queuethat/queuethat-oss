/**
 * The deterministic demo seed (supabase/seeds/10_demo_org.sql), for Playwright, concurrency
 * tests and browser verification. Local and CI only; the pilot never has these rows.
 */
export const DEMO_PASSWORD = 'password123';

export const demoUsers = {
  owner: { id: '00000000-0000-4000-8000-0000000000a1', email: 'owner@demo.test' },
  staff: { id: '00000000-0000-4000-8000-0000000000a2', email: 'staff@demo.test' },
  e2eOwner: { id: '00000000-0000-4000-8000-0000000000a3', email: 'owner@e2e.test' },
  e2eStaff: { id: '00000000-0000-4000-8000-0000000000a4', email: 'staff@e2e.test' },
  otherOwner: { id: '00000000-0000-4000-8000-0000000000b1', email: 'owner@other.test' },
} as const;

export const demo = {
  orgId: '00000000-0000-4000-8000-00000000d001',
  locationId: '00000000-0000-4000-8000-00000000d101',
  locationSlug: 'demo-barber',
  queues: {
    walkIns: '00000000-0000-4000-8000-00000000d201',
    kids: '00000000-0000-4000-8000-00000000d202',
  },
  services: {
    haircut: '00000000-0000-4000-8000-00000000d301',
    beardTrim: '00000000-0000-4000-8000-00000000d302',
    kidsCut: '00000000-0000-4000-8000-00000000d303',
  },
  counters: {
    chair1: '00000000-0000-4000-8000-00000000d401',
    chair2: '00000000-0000-4000-8000-00000000d402',
  },
} as const;

export const otherOrg = {
  orgId: '00000000-0000-4000-8000-00000000e001',
  locationId: '00000000-0000-4000-8000-00000000e101',
  locationSlug: 'other-salon',
  queues: { walkIns: '00000000-0000-4000-8000-00000000e201' },
} as const;
