// HubSpot API responses as documented at developers.hubspot.com (CRM Contacts, Notes and OAuth APIs).
// Hand-written from the reference, not recorded from a live account: no HubSpot account is used in this repo.
export const searchEmpty = { status: 200, body: { total: 0, results: [] } };
export const searchHit = {
  status: 200,
  body: { total: 1, results: [{ id: '501', properties: { phone: '+14155550123' } }] },
};
export const contactCreated = { status: 201, body: { id: '777', properties: {} } };
export const noteCreated = { status: 201, body: { id: '9001' } };
export const tokenOk = {
  status: 200,
  body: {
    access_token: 'CJ-new-access',
    refresh_token: 'na1-new-refresh',
    expires_in: 1800,
    token_type: 'bearer',
  },
};
export const unauthorized = {
  status: 401,
  body: { status: 'error', message: 'secret detail', category: 'INVALID_AUTHENTICATION' },
};
