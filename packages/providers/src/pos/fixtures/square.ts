// Square API responses as documented at developer.squareup.com (Customers API, OAuth API). Hand-written
// from the reference, not recorded from a live account: no Square account is used in this repo.
export const searchEmpty = { status: 200, body: {} };
export const searchHit = {
  status: 200,
  body: { customers: [{ id: 'CUST1', phone_number: '+14155550123', note: 'Prefers mornings' }] },
};
export const created = { status: 200, body: { customer: { id: 'CUST2' } } };
export const updated = { status: 200, body: { customer: { id: 'CUST1' } } };
export const tokenOk = {
  status: 200,
  body: {
    access_token: 'EAAA-new-access',
    refresh_token: 'EQAA-new-refresh',
    expires_at: '2099-01-31T00:00:00Z',
    merchant_id: 'MLSQ1',
    token_type: 'bearer',
  },
};
export const unauthorized = {
  status: 401,
  body: {
    errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: 'secret detail' }],
  },
};
