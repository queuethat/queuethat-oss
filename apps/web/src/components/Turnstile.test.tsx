import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #576: when the Turnstile widget can't produce a token, the join page has to say so.

interface Options {
  callback: (token: string) => void;
  'expired-callback': () => void;
  'error-callback': () => void;
  'before-interactive-callback': () => void;
  'after-interactive-callback': () => void;
}

let options: Options | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules(); // the script loader remembers its promise
  document.head.innerHTML = '';
  options = undefined;
  window.turnstile = {
    render: (_el, o) => {
      options = o as unknown as Options;
      return 'w1';
    },
    remove: () => {},
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.turnstile;
});

async function show() {
  const { Turnstile, CHALLENGE_TIMEOUT_MS } = await import('./Turnstile.tsx');
  const onToken = vi.fn();
  const onProblem = vi.fn();
  render(
    <Turnstile
      siteKey="k"
      language="en"
      round={0}
      label="check"
      onToken={onToken}
      onProblem={onProblem}
    />,
  );
  const script = document.head.querySelector('script')!;
  return { onToken, onProblem, script, CHALLENGE_TIMEOUT_MS };
}

const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0];

describe('Turnstile problems', () => {
  it('reports a problem when no token arrives within the timeout', async () => {
    const { onProblem, script, CHALLENGE_TIMEOUT_MS } = await show();
    await act(async () => script.onload?.(new Event('load')));
    expect(last(onProblem)).toBe(false);

    await act(() => vi.advanceTimersByTimeAsync(CHALLENGE_TIMEOUT_MS - 1));
    expect(last(onProblem)).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(last(onProblem)).toBe(true);
  });

  it('reports no problem when a token arrives in time', async () => {
    const { onToken, onProblem, script, CHALLENGE_TIMEOUT_MS } = await show();
    await act(async () => script.onload?.(new Event('load')));
    act(() => options!.callback('tok'));
    expect(onToken).toHaveBeenLastCalledWith('tok');

    await act(() => vi.advanceTimersByTimeAsync(CHALLENGE_TIMEOUT_MS * 2));
    expect(last(onProblem)).toBe(false);
  });

  it('reports a problem straight away when the widget errors, and clears it on a later token', async () => {
    const { onToken, onProblem, script } = await show();
    await act(async () => script.onload?.(new Event('load')));

    act(() => options!['error-callback']());
    expect(last(onProblem)).toBe(true);
    expect(onToken).toHaveBeenLastCalledWith(null);

    // The widget retries on its own and may still succeed.
    act(() => options!.callback('late'));
    expect(last(onProblem)).toBe(false);
    expect(onToken).toHaveBeenLastCalledWith('late');
  });

  it('reports a problem straight away when the script is blocked', async () => {
    const { onProblem, script } = await show();
    await act(async () => script.onerror?.(new Event('error')));
    expect(last(onProblem)).toBe(true);
  });

  it('starts the clock again when a token expires and the next one stalls', async () => {
    const { onToken, onProblem, script, CHALLENGE_TIMEOUT_MS } = await show();
    await act(async () => script.onload?.(new Event('load')));
    act(() => options!.callback('tok'));
    await act(() => vi.advanceTimersByTimeAsync(CHALLENGE_TIMEOUT_MS * 3));
    expect(last(onProblem)).toBe(false);

    act(() => options!['expired-callback']());
    expect(onToken).toHaveBeenLastCalledWith(null);
    await act(() => vi.advanceTimersByTimeAsync(CHALLENGE_TIMEOUT_MS - 1));
    expect(last(onProblem)).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(last(onProblem)).toBe(true);
  });

  // #602: an interactive challenge (Cloudflare's "Verify you are human" box) waits for a person,
  // who may read the instructions slowly. The timeout is for a widget that doesn't answer.
  it('gives a person time to tick an interactive challenge', async () => {
    const { onProblem, script, CHALLENGE_TIMEOUT_MS } = await show();
    await act(async () => script.onload?.(new Event('load')));

    await act(() => vi.advanceTimersByTimeAsync(CHALLENGE_TIMEOUT_MS - 1));
    act(() => options!['before-interactive-callback']());
    await act(() => vi.advanceTimersByTimeAsync(CHALLENGE_TIMEOUT_MS * 6));
    expect(last(onProblem)).toBe(false);
  });

  it('takes a problem back once the widget shows an interactive challenge', async () => {
    const { onProblem, script, CHALLENGE_TIMEOUT_MS } = await show();
    await act(async () => script.onload?.(new Event('load')));
    await act(() => vi.advanceTimersByTimeAsync(CHALLENGE_TIMEOUT_MS));
    expect(last(onProblem)).toBe(true);

    act(() => options!['before-interactive-callback']());
    expect(last(onProblem)).toBe(false);
  });

  it('starts the clock again when the person is done and no token follows', async () => {
    const { onToken, onProblem, script, CHALLENGE_TIMEOUT_MS } = await show();
    await act(async () => script.onload?.(new Event('load')));
    act(() => options!['before-interactive-callback']());
    act(() => options!['after-interactive-callback']());

    await act(() => vi.advanceTimersByTimeAsync(CHALLENGE_TIMEOUT_MS - 1));
    expect(last(onProblem)).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(last(onProblem)).toBe(true);

    act(() => options!.callback('late'));
    expect(last(onProblem)).toBe(false);
    expect(onToken).toHaveBeenLastCalledWith('late');
  });

  it('ignores a script failure that lands after the widget was removed', async () => {
    const { onProblem, script } = await show();
    cleanup();
    onProblem.mockClear();
    await act(async () => script.onerror?.(new Event('error')));
    expect(onProblem).not.toHaveBeenCalled();
  });
});
