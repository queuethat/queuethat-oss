import postgres from 'postgres';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { confirmedAccount, NEW_ACCOUNT_PASSWORD, readAs } from './support/accounts.ts';

// T4 (#1298): "How many doctors?" makes one personal line per named provider plus the pool, with
// the template's services and form on every line, in the one setup action.
test.use({ staffUser: null });

const ADMIN_DATABASE_URL =
  process.env.E2E_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

// A tier-3 test template (catalog rows are immutable, so it is inserted once per database).
const PRACTICE = {
  key: 'e2e_practice',
  version: 1,
  name: { en: 'Test practice', es: 'Consulta de prueba' },
  description: { en: 'Doctors with their own lines', es: 'Médicos con su propia fila' },
  providers: { noun: { en: 'doctor', es: 'médico' }, default_count: 3, pool: true },
  queues: [
    {
      name: { en: 'Visits', es: 'Visitas' },
      prefix: 'V',
      show_eta: true,
      services: [{ name: { en: 'Checkup', es: 'Revisión' }, minutes: 15 }],
    },
  ],
  resources: [],
  form: {
    name: { en: 'Visit details', es: 'Detalles' },
    fields: [
      {
        key: 'reason',
        type: 'short_text',
        label: { en: 'Reason', es: 'Motivo' },
        sensitivity: 'normal',
      },
    ],
  },
};

test.beforeAll(async () => {
  const sql = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`insert into app.template_catalog (key, version, payload, tier, mode)
      values (${PRACTICE.key}, 1, ${sql.json(PRACTICE)}, 3, 'walk_in') on conflict do nothing`;
  } finally {
    await sql.end();
  }
});

test('three doctors named by the owner get their own lines, a pool, and the form', async ({
  devices,
}) => {
  const { staff } = devices;
  const email = await confirmedAccount();
  await staff.goto('/auth/sign-in?next=%2Fonboarding');
  await staff.getByLabel('Email').fill(email);
  await staff.getByLabel('Password').fill(NEW_ACCOUNT_PASSWORD);
  await staff.getByRole('button', { name: 'Sign in', exact: true }).click();
  // clock-ok: Date.now() only makes the business name unique.
  await staff.getByLabel('Business name').fill(`Practice ${Date.now()}`);
  await staff.getByRole('button', { name: 'Next' }).click();
  await staff.getByLabel('Location name').fill('Main Street');
  await staff.getByLabel('Time zone').fill('America/Winnipeg');
  await staff.getByRole('button', { name: 'Next' }).click();

  await staff.getByLabel('Search templates').fill('test practice');
  await staff.getByRole('button', { name: 'Use this' }).click();
  await expect(staff.getByLabel('How many? (one line per doctor)')).toHaveValue('3');
  await expect(staff.getByLabel('Name of doctor 3')).toHaveValue('Doctor 3');
  await staff.getByLabel('Name of doctor 1').fill('Dr. Lee');
  await staff.getByLabel('Name of doctor 2').fill('Dr. Patel');
  await staff.getByLabel('Name of doctor 3').fill('Dr. Ng');
  await expect(staff.getByLabel('Add an “Anyone available” line')).toBeChecked();
  await expectNoSeriousA11yViolations(staff);
  await staff.getByRole('button', { name: 'Create my business' }).click();

  await expect(staff.getByText('Your line is live')).toBeVisible();
  const [queues, services, forms] = await readAs(email, [
    'queues?select=name,kind&order=name',
    'services?select=name',
    'forms?select=name,status&is_queue_default=eq.false',
  ]);
  expect(queues).toEqual([
    { name: 'Anyone available', kind: 'pool' },
    { name: 'Dr. Lee', kind: 'provider' },
    { name: 'Dr. Ng', kind: 'provider' },
    { name: 'Dr. Patel', kind: 'provider' },
  ]);
  expect(services).toHaveLength(4);
  expect(forms).toEqual([{ name: 'Visit details', status: 'published' }]);
});
