import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWakeLock } from './useWakeLock.ts';

function stubWakeLock() {
  const release = vi.fn().mockResolvedValue(undefined);
  const sentinel = { released: false, release };
  const request = vi.fn().mockResolvedValue(sentinel);
  Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
  return { request, release };
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'wakeLock');
});

describe('useWakeLock', () => {
  it('requests a screen lock while mounted and releases it on unmount', async () => {
    const { request, release } = stubWakeLock();
    const { unmount } = renderHook(() => useWakeLock());
    expect(request).toHaveBeenCalledWith('screen');
    await Promise.resolve();
    unmount();
    expect(release).toHaveBeenCalled();
  });

  it('does nothing when the browser has no Wake Lock API', () => {
    expect(() => renderHook(() => useWakeLock()).unmount()).not.toThrow();
  });
});
