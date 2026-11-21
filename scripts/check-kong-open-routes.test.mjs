import { expect, test } from 'vitest';
import { openRouteNames, shadowed } from './check-kong-open-routes.mjs';

const KONG = `
        paths:
          - /functions/v1/join-pass
        paths:
          - /functions/v1/domain-check
        paths:
          - /functions/v1/
        paths:
          - /rest/v1/
`;

test('finds the open function routes and not the catch-all', () => {
  expect(openRouteNames(KONG)).toEqual(['join-pass', 'domain-check']);
});

test('a function that starts with an open route name is reported, the route itself is not', () => {
  expect(shadowed(['domain-check'], ['domain-check', 'billing', 'join-pass'])).toEqual([]);
  expect(shadowed(['domain-check'], ['domain-check', 'domain-check-admin'])).toEqual([
    { open: 'domain-check', fn: 'domain-check-admin' },
  ]);
});
