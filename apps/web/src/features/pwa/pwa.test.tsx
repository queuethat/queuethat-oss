import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineBanner } from './OfflineBanner.tsx';
import { UpdatePrompt } from './UpdatePrompt.tsx';
import { updatePolicyFor } from './updatePolicy.ts';

const sw = vi.hoisted(() => ({
  updateReady: false,
  apply: vi.fn(),
}));

vi.mock('./useAppUpdate.ts', () => ({
  useAppUpdate: () => ({ updateReady: sw.updateReady, apply: sw.apply }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('updatePolicyFor', () => {
  it.each([
    ['/staff', 'prompt'],
    ['/staff/queue/1', 'prompt'],
    ['/admin', 'prompt'],
    ['/auth/sign-in', 'prompt'],
    ['/display', 'auto'],
    ['/kiosk', 'auto'],
    ['/q/demo-barber', 'silent'],
    ['/v/some-token', 'silent'],
    ['/', 'silent'],
    ['/staffing', 'silent'],
  ])('%s -> %s', (path, policy) => {
    expect(updatePolicyFor(path)).toBe(policy);
  });
});

describe('OfflineBanner', () => {
  it('appears when the browser goes offline and hides when it is back', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    render(<OfflineBanner />);
    expect(screen.queryByTestId('offline-banner')).toBeNull();

    onLine.mockReturnValue(false);
    act(() => void window.dispatchEvent(new Event('offline')));
    expect(screen.getByRole('status').textContent).toMatch(/offline/i);

    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });
});

describe('UpdatePrompt', () => {
  async function renderAt(path: string) {
    const router = createRouter({
      routeTree: createRootRoute({ component: UpdatePrompt }),
      history: createMemoryHistory({ initialEntries: [path] }),
    });
    await router.load();
    render(<RouterProvider router={router} />);
  }

  beforeEach(() => {
    sw.updateReady = true;
    sw.apply.mockClear();
  });

  it('asks staff before reloading', async () => {
    await renderAt('/staff');
    expect(await screen.findByTestId('update-prompt')).toBeTruthy();
    expect(sw.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(sw.apply).toHaveBeenCalled();
  });

  it('reloads displays without asking', async () => {
    await renderAt('/display');
    await vi.waitFor(() => expect(sw.apply).toHaveBeenCalled());
    expect(screen.queryByTestId('update-prompt')).toBeNull();
  });

  it('leaves guests alone', async () => {
    await renderAt('/v/some-token');
    expect(screen.queryByTestId('update-prompt')).toBeNull();
    expect(sw.apply).not.toHaveBeenCalled();
  });

  it('hides the prompt on Later', async () => {
    await renderAt('/admin');
    fireEvent.click(await screen.findByRole('button', { name: 'Later' }));
    expect(screen.queryByTestId('update-prompt')).toBeNull();
    expect(sw.apply).not.toHaveBeenCalled();
  });

  it('shows nothing when there is no update', async () => {
    sw.updateReady = false;
    await renderAt('/staff');
    expect(screen.queryByTestId('update-prompt')).toBeNull();
  });
});
