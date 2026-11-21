import { describe, expect, it } from 'vitest';
import { dnsTargetFor } from './dnsTarget.ts';

const ORIGIN = 'http://localhost:5173';

describe('dnsTargetFor', () => {
  it('is the host of the public URL when the deployment sets no target', () => {
    expect(dnsTargetFor('', 'https://queue.example.com/app', ORIGIN)).toBe('queue.example.com');
    expect(dnsTargetFor(undefined, 'https://queue.example.com', ORIGIN)).toBe('queue.example.com');
  });

  it('falls back to the page itself without a public URL', () => {
    expect(dnsTargetFor('', '', ORIGIN)).toBe('localhost');
  });

  it('uses the configured target, tidied to a bare lower-case hostname', () => {
    expect(
      dnsTargetFor(' HTTPS://Edge.Provider.Example./ ', 'https://queue.example.com', ORIGIN),
    ).toBe('edge.provider.example');
  });
});
