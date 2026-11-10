import { ETA_MESSAGES_EN, formatEta, type EtaState, type Translate } from '@qm/domain';
import { describe, expect, it } from 'vitest';
import i18n from '../lib/i18n.ts';

// #484: the status page showed "eta.next" because the bundled namespace and formatEta's keys
// disagreed. Wire the real i18n instance, exactly as StatusPage does, and read every state.
describe('ETA wording through i18n', () => {
  const t = i18n.getFixedT(null, 'eta') as Translate;

  it.each(Object.keys(ETA_MESSAGES_EN).map((key) => key.replace(/^eta\./, '') as EtaState))(
    '%s renders words, not its key',
    (state) => {
      const text = formatEta(state, 10, 20, t);
      expect(text).not.toMatch(/^eta\./);
      expect(text).toBe(
        ETA_MESSAGES_EN[`eta.${state}` as keyof typeof ETA_MESSAGES_EN]
          .replace('{{low}}', '10')
          .replace('{{high}}', '20'),
      );
    },
  );
});
