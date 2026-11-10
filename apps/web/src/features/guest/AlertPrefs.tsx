import { Button, Checkbox } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { useAlertPrefs, useSetAlertPrefs } from './api.ts';

/**
 * "Choose your alerts" on the status page (N-17, 2P-NTF2): one checkbox per alert the database
 * offers, saved as soon as it changes. The list and the current choice come from
 * api.guest_get_alert_prefs, so a new trigger appears here when its template exists. Turning off
 * "It's my turn" is allowed, with a warning, because the status page itself still shows the call.
 */
export function AlertPrefs({ token }: { token: string }) {
  const { t } = useTranslation('guest');
  const prefs = useAlertPrefs(token);
  const save = useSetAlertPrefs(token);
  const [open, setOpen] = useState(false);
  // What the boxes show while a save is in flight, so a tap changes the box at once.
  const [draft, setDraft] = useState<string[] | null>(null);
  if (!prefs.data?.available?.length) return null;

  const chosen = draft ?? prefs.data.triggers ?? [];
  const toggle = (trigger: string, on: boolean) => {
    const next = prefs.data.available!.filter((a) => (a === trigger ? on : chosen.includes(a)));
    setDraft(next);
    save.mutate(next, { onSettled: () => setDraft(null) });
  };

  return (
    <section className="flex flex-col gap-2" aria-labelledby="alert-prefs-title">
      <h2 id="alert-prefs-title" className="sr-only">
        {t('status.alerts.title')}
      </h2>
      <Button
        variant="secondary"
        className="min-h-target-big w-full"
        aria-expanded={open}
        aria-controls="alert-prefs-list"
        onClick={() => setOpen((v) => !v)}
      >
        {t('status.alerts.toggle')}
      </Button>
      {open ? (
        <div
          id="alert-prefs-list"
          className="flex flex-col gap-1 rounded-card border border-border p-3"
        >
          <p className="text-sm text-muted">{t('status.alerts.intro')}</p>
          {prefs.data.available.map((trigger) => (
            <Checkbox
              key={trigger}
              label={t(`status.alerts.trigger.${trigger}`, { defaultValue: trigger })}
              checked={chosen.includes(trigger)}
              onChange={(e) => toggle(trigger, e.target.checked)}
            />
          ))}
          {!chosen.includes('called') ? (
            <p role="status" className="text-sm font-medium text-warning-strong">
              {t('status.alerts.calledOffWarning')}
            </p>
          ) : null}
          {save.isError ? (
            <p role="alert" className="text-sm font-medium text-danger-strong">
              {t('status.alerts.saveFailed')}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
