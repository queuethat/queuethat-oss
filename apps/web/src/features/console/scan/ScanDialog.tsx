import { errorCode } from '@qm/domain';
import { Badge, Button, Card, Dialog, Input } from '@qm/ui';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useFindByScanCode, type ConsoleVisit, type VisitAction } from '../api.ts';
import { parseScanCode } from './parse.ts';
import { useQrScanner } from './useQrScanner.ts';

/** Actions offered on a scanned guest, in button order; the database decides which apply. */
const SCAN_ACTIONS = [
  'check_in',
  'call',
  'start',
  'recall',
  'complete',
] as const satisfies readonly VisitAction[];

/**
 * Scan a guest's QR (S-13, #142) to find their visit and act on it. The code is resolved by
 * `find_visit_by_scan_code`, which answers one "not found" for an unknown code, an earlier day
 * and another location; the visit is then shown from the console's live list with the actions
 * the database allows. Typing the code is always available. The camera is on only while open.
 */
export function ScanDialog({
  open,
  onClose,
  locationId,
  visits,
  onAction,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  locationId: string;
  visits: ConsoleVisit[];
  onAction: (visit: ConsoleVisit, action: VisitAction) => void | Promise<unknown>;
  busy?: string | null;
}) {
  const { t } = useTranslation('staff');
  const find = useFindByScanCode(locationId);
  const [found, setFound] = useState<string | null>(null);
  const [error, setError] = useState<'notFound' | 'failed' | null>(null);
  const [typed, setTyped] = useState('');

  const lookup = (text: string) => {
    const code = parseScanCode(text);
    if (!code) {
      setFound(null);
      return setError('notFound');
    }
    find.mutate(code, {
      onSuccess: (id) => {
        setError(null);
        setFound(id);
      },
      onError: (e) => {
        setFound(null);
        setError(errorCode(e) === 'not_found' ? 'notFound' : 'failed');
      },
    });
  };
  const { video, problem } = useQrScanner(open && !found, lookup);
  const visit = found ? visits.find((v) => v.id === found) : undefined;
  const close = () => {
    setFound(null);
    setError(null);
    setTyped('');
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    lookup(typed);
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('console.scan.title')}
      description={t('console.scan.description')}
      footer={
        <Button variant="secondary" onClick={close}>
          {t('console.scan.close')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {visit ? (
          <Card data-testid="scan-result" className="flex flex-wrap items-center gap-3">
            <span className="text-2xl font-bold tabular-nums">{visit.ticket}</span>
            <span className="min-w-0 flex-1 truncate">{visit.name ?? t('console.noName')}</span>
            <Badge>{t(`console.timeline.status.${visit.status}`)}</Badge>
            {SCAN_ACTIONS.filter((a) => visit.actions.includes(a)).map((action) => (
              <Button
                key={action}
                disabled={busy === visit.id}
                aria-label={t(`console.actionLabel.${action}`, { ticket: visit.ticket })}
                onClick={() => void onAction(visit, action)}
              >
                {t(`console.action.${action}`)}
              </Button>
            ))}
            <Button variant="secondary" onClick={() => setFound(null)}>
              {t('console.scan.again')}
            </Button>
          </Card>
        ) : found ? (
          <p role="status">{t('console.scan.notOnList')}</p>
        ) : (
          <>
            {problem ? (
              <p role="alert" className="text-danger-strong">
                {t(`console.scan.camera.${problem}`)}
              </p>
            ) : (
              <video
                ref={video}
                muted
                playsInline
                aria-label={t('console.scan.preview')}
                className="aspect-square w-full rounded-card bg-black object-cover"
              />
            )}
          </>
        )}
        {error ? (
          <p role="alert" className="font-semibold text-danger-strong">
            {t(`console.scan.${error}`)}
          </p>
        ) : null}
        <form onSubmit={submit} className="flex items-end gap-2" noValidate>
          <div className="min-w-0 flex-1">
            <Input
              label={t('console.scan.manual')}
              value={typed}
              autoCapitalize="characters"
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
          <Button type="submit" variant="secondary">
            {t('console.scan.find')}
          </Button>
        </form>
      </div>
    </Dialog>
  );
}
