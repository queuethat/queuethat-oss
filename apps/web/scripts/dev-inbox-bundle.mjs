// The fake SMS inbox (2P-NTF11, #183) posts to the dev-sms-inbound function. That name appears
// in no production code, so finding it in dist/ means the dev route shipped.

export const DEV_INBOX_MARKER = 'dev-sms-inbound';

/** True when `text` contains the dev inbox's code. */
export function hasDevInbox(text) {
  return text.includes(DEV_INBOX_MARKER);
}
