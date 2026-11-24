import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import { isFeatureGated, PlanGateNotice } from './PlanGateNotice.tsx';

beforeAll(() => loadNamespaces('common'));
afterEach(cleanup);

describe('PlanGateNotice', () => {
  it('recognises the database refusal and nothing else', () => {
    expect(isFeatureGated(new Error('feature_not_in_plan'))).toBe(true);
    expect(isFeatureGated(new Error('plan_limit_reached'))).toBe(false);
    expect(isFeatureGated(null)).toBe(false);
  });

  it('says the plan lacks the feature and that existing work keeps running', async () => {
    render(<PlanGateNotice feature="api" />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      "API keys and webhooks aren't part of this plan. What you already set up keeps working.",
    );
  });

  it('says the plan has no location comparison', async () => {
    render(<PlanGateNotice feature="rollup" />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Comparing your locations side by side isn't part of this plan. What you already set up keeps working.",
    );
  });

  it('says how many queues the plan allows when the database reports it', async () => {
    render(<PlanGateNotice feature="queues" limit={2} />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This location has all the queues its plan allows: 2. What you already set up keeps working.',
    );
  });

  it('still reads well without a limit', async () => {
    render(<PlanGateNotice feature="queues" />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This location has all the queues its plan allows. What you already set up keeps working.',
    );
  });
});
