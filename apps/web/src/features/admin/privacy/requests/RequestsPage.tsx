import {
  Button,
  Checkbox,
  ConfirmDestructive,
  EmptyState,
  Input,
  PageHeader,
  Skeleton,
} from '@qm/ui';
import { Navigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import { useCurrentOrg } from '../../../auth/current.ts';
import {
  downloadJson,
  useEraseGuest,
  useExportGuest,
  useFindGuest,
  type GuestMatch,
} from './api.ts';

const KNOWN_ERRORS = ['invalid_input', 'not_found', 'mfa_required'];

function errorKey(error: Error | null) {
  if (!error) return null;
  return `requests.errors.${KNOWN_ERRORS.includes(error.message) ? error.message : 'unknown'}` as 'requests.errors.unknown';
}

/** Owners and admins answer a data request: find the person, export or erase (2P-PRV4, #191). */
export function RequestsPage() {
  const { t } = useTranslation('admin-privacy');
  const org = useCurrentOrg();
  if (!org) return <Skeleton label={t('loading')} rows={2} />;
  // Managers and staff never reach this page: send them back to the admin home.
  if (org.role !== 'owner' && org.role !== 'admin') return <Navigate to="/admin" replace />;
  return <Requests />;
}

function Requests() {
  const { t } = useTranslation('admin-privacy');
  const find = useFindGuest();
  const [text, setText] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setDone(null);
    find.mutate(text);
  };
  const failure = errorKey(find.error);
  return (
    <div className="flex flex-col gap-6 pb-8">
      <PageHeader title={t('requests.title')} description={t('requests.intro')} />
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <Input
          label={t('requests.search')}
          hint={t('requests.searchHint')}
          autoComplete="off"
          required
          maxLength={254}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" className="self-start" loading={find.isPending}>
          {t('requests.find')}
        </Button>
      </form>
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(failure) : null}
      </p>
      {done ? (
        <p role="status" data-testid="erased-notice" className="font-medium">
          {done}
        </p>
      ) : null}
      {find.data && find.data.length === 0 ? <EmptyState title={t('requests.none')} /> : null}
      <ul className="flex flex-col gap-4">
        {find.data?.map((g) => (
          <Match
            key={g.id}
            match={g}
            onErased={(message) => {
              setDone(message);
              find.reset();
            }}
          />
        ))}
      </ul>
    </div>
  );
}

function Match({ match, onErased }: { match: GuestMatch; onErased: (message: string) => void }) {
  const { t, i18n } = useTranslation('admin-privacy');
  const exporter = useExportGuest();
  const erase = useEraseGuest();
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [keep, setKeep] = useState(true);
  // The typed word is the guest's name, or a fixed word for a guest who gave none.
  const word = match.name?.trim() || t('requests.erase.fallbackWord');
  const label = match.name || t('requests.noName');
  const failure = errorKey(exporter.error ?? erase.error);
  return (
    <li
      data-testid="match"
      className="flex flex-col gap-3 rounded-control border border-border p-4"
    >
      <p className="text-lg font-medium">{label}</p>
      <p className="text-muted">
        {t('requests.summary', {
          count: match.visitCount,
          last: match.lastVisitAt
            ? new Date(match.lastVisitAt).toLocaleDateString(i18n.language)
            : t('requests.never'),
        })}
      </p>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="secondary"
          aria-label={t('requests.exportFor', { name: label })}
          loading={exporter.isPending}
          onClick={() =>
            exporter.mutate(match.id, {
              onSuccess: (data) => downloadJson(`guest-${match.id}.json`, data),
            })
          }
        >
          {t('requests.export')}
        </Button>
        <ConfirmDestructive
          triggerLabel={t('requests.erase.trigger')}
          triggerAriaLabel={t('requests.erase.triggerFor', { name: label })}
          triggerVariant="secondary"
          title={t('requests.erase.title', { name: label })}
          description={t('requests.erase.body')}
          confirmLabel={t('requests.erase.confirm')}
          cancelLabel={t('requests.erase.cancel')}
          confirmDisabled={typed.trim() !== word || reason.trim() === ''}
          onConfirm={() =>
            erase
              .mutateAsync({ guestId: match.id, reason, keepSuppression: keep })
              .then((r) =>
                onErased(
                  t('requests.erase.done', {
                    visits: r.visitsAnonymized,
                    contacts: r.contactsDeleted,
                  }),
                ),
              )
              .catch(() => undefined)
          }
        >
          <Input
            label={t('requests.erase.typeWord', { word })}
            autoComplete="off"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
          <Input
            label={t('requests.erase.reason')}
            hint={t('requests.erase.reasonHint')}
            maxLength={200}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Checkbox
            label={t('requests.erase.keep')}
            hint={t('requests.erase.keepHint')}
            checked={keep}
            onChange={(event) => setKeep(event.target.checked)}
          />
        </ConfirmDestructive>
      </div>
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(failure) : null}
      </p>
    </li>
  );
}
