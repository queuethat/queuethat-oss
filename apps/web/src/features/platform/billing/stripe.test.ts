import { describe, expect, it } from 'vitest';
import { stripeCustomerUrl } from './stripe.ts';

describe('stripeCustomerUrl', () => {
  it('links the live dashboard by default', () => {
    expect(stripeCustomerUrl('cus_Abc123', '')).toBe(
      'https://dashboard.stripe.com/customers/cus_Abc123',
    );
  });
  it('uses a sandbox base and trims trailing slashes', () => {
    expect(stripeCustomerUrl('cus_Abc123', 'https://dashboard.stripe.com/test/')).toBe(
      'https://dashboard.stripe.com/test/customers/cus_Abc123',
    );
  });
  it('has no link without a customer id', () => {
    expect(stripeCustomerUrl(null, '')).toBeNull();
    expect(stripeCustomerUrl('', '')).toBeNull();
  });
  it('refuses ids that are not customer ids, so nothing else reaches the address', () => {
    for (const id of [
      'sub_123',
      'cus_',
      'cus_a/../x',
      'cus_a?x=1',
      'cus_a b',
      'https://evil.test',
    ]) {
      expect(stripeCustomerUrl(id, '')).toBeNull();
    }
  });
  it('falls back to the live dashboard for a base that is not https', () => {
    for (const base of [
      'http://dashboard.stripe.com',
      'javascript:alert(1)',
      'https://x.test/?q=1',
      'ftp://x',
    ]) {
      expect(stripeCustomerUrl('cus_1', base)).toBe('https://dashboard.stripe.com/customers/cus_1');
    }
  });
});
