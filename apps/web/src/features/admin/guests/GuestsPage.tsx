import { EmptyState, Input, LinkButton, PageHeader, Spinner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useDeferredValue, useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { ScreenEmpty } from '../../../components/ScreenEmpty.tsx';
import { publicJoinUrl } from '../poster/url.ts';
import { useNoVisitsYet } from '../dashboard/setup/api.ts';
import { MIN_SEARCH_LENGTH, searchGuestsQuery } from './api.ts';

/** Staff find a regular by name, phone or email and open their profile (2P-CRM3, #186). */
export function GuestsPage() {
  const { t, i18n } = useTranslation('admin-guests');
  const { t: te } = useTranslation('empty');
  const noVisits = useNoVisitsYet();
  const { location } = useCurrentLocation();
  const role = useCurrentOrg()?.role;
  const isManager = role === 'owner' || role === 'admin' || role === 'manager';
  const [text, setText] = useState('');
  const query = useDeferredValue(text.trim());
  const ready = !!location && query.length >= MIN_SEARCH_LENGTH;
  const results = useQuery({ ...searchGuestsQuery(location?.id ?? '', query), enabled: ready });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-8">
      <PageHeader
        title={t('title')}
        actions={
          <>
            {isManager ? (
              <LinkButton
                variant="secondary"
                render={(p) => <Link to="/admin/guests/duplicates" {...p} />}
              >
                {t('duplicates')}
              </LinkButton>
            ) : null}
            {role === 'owner' || role === 'admin' ? (
              <LinkButton
                variant="secondary"
                render={(p) => <Link to="/admin/guests/import" {...p} />}
              >
                {t('importExport')}
              </LinkButton>
            ) : null}
          </>
        }
      />
      <Input
        label={t('search.label')}
        hint={t('search.hint')}
        type="search"
        autoComplete="off"
        maxLength={100}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {!ready ? (
        noVisits ? (
          <ScreenEmpty
            kind="guests"
            secondary={
              location ? (
                <LinkButton
                  variant="secondary"
                  href={publicJoinUrl(location.slug)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {te('guests.join')}
                </LinkButton>
              ) : undefined
            }
          />
        ) : (
          <EmptyState title={t('search.idle')} />
        )
      ) : results.isPending ? (
        <Spinner label={t('loading')} />
      ) : results.isError ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('search.failed')}
        </p>
      ) : results.data.length === 0 ? (
        <EmptyState title={t('search.empty')} />
      ) : (
        <table className="w-full text-left">
          <caption className="sr-only">{t('search.results')}</caption>
          <thead>
            <tr className="text-muted">
              <th scope="col" className="py-2">
                {t('search.name')}
              </th>
              <th scope="col">{t('search.contact')}</th>
              <th scope="col">{t('search.visits')}</th>
              <th scope="col">{t('search.last')}</th>
            </tr>
          </thead>
          <tbody>
            {results.data.map((g) => {
              const name = g.name || t('search.noName');
              return (
                <tr key={g.id} data-testid="guest-row" className="border-t border-border">
                  <th scope="row" className="py-1 font-medium">
                    <Link
                      to="/admin/guests/$guestId"
                      params={{ guestId: g.id }}
                      aria-label={t('search.open', { name })}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {name}
                    </Link>
                  </th>
                  <td>{g.maskedContact}</td>
                  <td>{g.visitCount}</td>
                  <td>
                    {g.lastVisitAt
                      ? new Date(g.lastVisitAt).toLocaleDateString(i18n.language)
                      : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
