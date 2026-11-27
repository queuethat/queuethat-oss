import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import { CheckIn } from './CheckIn.tsx';

afterEach(cleanup);
beforeAll(() => loadNamespaces('guest'));

const view = (guest_actions: string[]) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CheckIn token="t" visit={{ status: 'expected', guest_actions } as never} />
    </QueryClientProvider>,
  );

describe('CheckIn', () => {
  it('offers the button only when the database lists check_in', () => {
    view(['leave', 'check_in']);
    expect(screen.getByRole('button', { name: "I'm here, check me in" })).toBeTruthy();
  });

  it('shows nothing when check_in is not offered', () => {
    view(['leave']);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
