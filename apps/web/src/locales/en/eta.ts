import { ETA_MESSAGES_EN } from '@qm/domain';

// formatEta (packages/domain) owns the ETA wording and asks for 'eta.<state>'. i18next reads the
// dot as nesting, so this namespace holds { eta: { <state>: text } } (#484: flat keys showed raw).
export default {
  eta: Object.fromEntries(
    Object.entries(ETA_MESSAGES_EN).map(([key, text]) => [key.replace(/^eta\./, ''), text]),
  ),
};
