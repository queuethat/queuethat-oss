import { Button, Checkbox, Dialog } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';
import { SHORTCUTS } from './config.ts';

/** Lists every shortcut from the one config map, and lets the user turn single keys off. */
export function ShortcutHelp({
  open,
  onClose,
  enabled,
  onEnabled,
}: {
  open: boolean;
  onClose: () => void;
  enabled: boolean;
  onEnabled: (on: boolean) => void;
}) {
  const { t } = useTranslation('staff');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('console.shortcuts.title')}
      description={t('console.shortcuts.description')}
      footer={<Button onClick={onClose}>{t('console.shortcuts.close')}</Button>}
    >
      <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        {SHORTCUTS.map(({ key, command }) => (
          <div key={command} className="contents">
            <dt>
              <kbd className="rounded border px-2 py-1 font-mono">{key.toUpperCase()}</kbd>
            </dt>
            <dd>{t(`console.shortcuts.command.${command}`)}</dd>
          </div>
        ))}
      </dl>
      <Checkbox
        label={t('console.shortcuts.enable')}
        checked={enabled}
        onChange={(event) => onEnabled(event.target.checked)}
      />
    </Dialog>
  );
}
