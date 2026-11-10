import { Badge, Button, EmptyState, Input, PageHeader, ScrollRegion, Spinner } from '@qm/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { formatWhen } from '../format.ts';
import { opsError } from '../ops/api.ts';
import { AUDIT_PAGE, auditQuery, exportAudit, saveCsv, type AuditExport } from './api.ts';
import {
  auditFilters,
  auditPageLinks,
  isCalendarDay,
  parseAuditSearch,
  rangeInverted,
  type AuditSearch,
} from './search.ts';

/** Where the page lives: a registered platform page (see ../pages.tsx). */
const AUDIT = { to: '/platform/$', params: { _splat: 'audit' } } as const;

type FieldError = 'invalidId' | 'invalidAction' | 'invalidDate' | 'rangeInverted';
type FieldErrors = Partial<Record<'actor' | 'org' | 'action' | 'range', FieldError>>;

/** Checks what the operator typed; the address parser would otherwise drop a bad value silently. */
function validate(search: Record<string, string>): { errors: FieldErrors; clean: AuditSearch } {
  const clean = parseAuditSearch(search);
  const errors: FieldErrors = {};
  if (search.actor && !clean.actor) errors.actor = 'invalidId';
  if (search.org && !clean.org) errors.org = 'invalidId';
  if (search.action && !clean.action) errors.action = 'invalidAction';
  if ((search.from && !isCalendarDay(search.from)) || (search.to && !isCalendarDay(search.to))) {
    errors.range = 'invalidDate';
  } else if (rangeInverted(clean)) errors.range = 'rangeInverted';
  return { errors, clean };
}

/**
 * `/platform/audit` (#1133): every platform action across tenants and operators. Operators see
 * every actor; support see only their own rows (the database enforces it). Dates are the viewer's
 * local days. Contact data is masked by the database before it gets here.
 */
export function AuditPage({ filter, canSeeAll }: { filter: AuditSearch; canSeeAll: boolean }) {
  const { t, i18n } = useTranslation('platform');
  const navigate = useNavigate();
  const [errors, setErrors] = useState<FieldErrors>({});
  const filters = auditFilters(filter);
  const inverted = rangeInverted(filter);
  const audit = useQuery({ ...auditQuery(filter), enabled: !inverted });
  const last = audit.data?.hasMore ? audit.data.rows.at(-1)?.id : undefined;
  const links = auditPageLinks(filter, last);
  const zone = new Intl.DateTimeFormat(i18n.language, { timeZoneName: 'short' })
    .formatToParts(new Date())
    .find((part) => part.type === 'timeZoneName')?.value;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const typed: Record<string, string> = {};
    for (const key of ['actor', 'org', 'action', 'from', 'to']) {
      const value = String(data.get(key) ?? '').trim();
      if (value) typed[key] = value;
    }
    const { errors: found, clean } = validate(typed);
    setErrors(found);
    if (Object.keys(found).length === 0) void navigate({ ...AUDIT, search: clean });
  };

  const [parts, setParts] = useState(0);
  const exporting = useMutation({
    mutationFn: async (after: number | undefined) => ({
      after,
      result: await exportAudit(filters, after),
    }),
    onSuccess: ({ after, result }) => {
      const part = after === undefined ? 1 : parts + 1;
      setParts(part);
      if (result.rowCount > 0) {
        saveCsv(
          result.csv,
          `platform-audit-${filters.from ?? 'start'}-${filters.to ?? 'now'}${part > 1 ? `-part${part}` : ''}.csv`,
        );
      }
    },
  });
  const exported: AuditExport | undefined = exporting.data?.result;

  return (
    <section className="flex flex-col gap-6" aria-label={t('audit.title')}>
      <PageHeader title={t('audit.title')} />
      <p className="text-muted">{canSeeAll ? t('audit.intro') : t('audit.introOwn')}</p>

      <form className="flex flex-wrap items-end gap-4" role="search" onSubmit={submit} noValidate>
        {canSeeAll ? (
          <Input
            label={t('audit.actor')}
            hint={t('audit.actorHint')}
            name="actor"
            autoComplete="off"
            defaultValue={filter.actor ?? ''}
            {...(errors.actor ? { error: t(`audit.errors.${errors.actor}`) } : {})}
          />
        ) : null}
        <Input
          label={t('audit.org')}
          hint={t('audit.orgHint')}
          name="org"
          autoComplete="off"
          defaultValue={filter.org ?? ''}
          {...(errors.org ? { error: t(`audit.errors.${errors.org}`) } : {})}
        />
        <Input
          label={t('audit.action')}
          hint={t('audit.actionHint')}
          name="action"
          autoComplete="off"
          defaultValue={filter.action ?? ''}
          {...(errors.action ? { error: t(`audit.errors.${errors.action}`) } : {})}
        />
        <Input label={t('audit.from')} name="from" type="date" defaultValue={filter.from ?? ''} />
        <Input
          label={t('audit.to')}
          hint={zone ? t('audit.zoneHint', { zone }) : undefined}
          name="to"
          type="date"
          defaultValue={filter.to ?? ''}
          {...(errors.range ? { error: t(`audit.errors.${errors.range}`) } : {})}
        />
        <Button type="submit">{t('audit.submit')}</Button>
      </form>

      {inverted ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('audit.errors.rangeInverted')}
        </p>
      ) : audit.isError ? (
        <EmptyState title={t('ops.loadFailed')} />
      ) : !audit.data ? (
        <Spinner label={t('audit.loading')} />
      ) : audit.data.rows.length === 0 ? (
        <EmptyState title={filter.after ? t('audit.emptyPage') : t('audit.empty')} />
      ) : (
        <ScrollRegion label={t('audit.title')}>
          <table className="w-full text-left">
            <thead className="text-sm text-muted">
              <tr>
                <th className="py-2 pr-4">{t('audit.columns.when')}</th>
                <th className="py-2 pr-4">{t('audit.columns.actor')}</th>
                <th className="py-2 pr-4">{t('audit.columns.action')}</th>
                <th className="py-2 pr-4">{t('audit.columns.org')}</th>
                <th className="py-2 pr-4">{t('audit.columns.reason')}</th>
                <th className="py-2 pr-4">{t('audit.columns.grant')}</th>
                <th className="py-2">{t('audit.columns.details')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {audit.data.rows.map((row) => (
                <tr key={row.id} data-testid="audit-row">
                  <td className="py-3 pr-4 whitespace-nowrap">
                    {formatWhen(row.at, i18n.language, '')}
                  </td>
                  <td className="py-3 pr-4 break-all">
                    {row.actor_id === null ? (
                      t('audit.system')
                    ) : (
                      <Link
                        {...AUDIT}
                        search={{ ...filters, actor: row.actor_id }}
                        className="underline"
                      >
                        {row.actor_email ??
                          t('audit.deletedAccount', { id: row.actor_id.slice(0, 8) })}
                      </Link>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    <code>{row.action}</code>
                  </td>
                  <td className="py-3 pr-4">
                    {row.org_id === null ? (
                      '—'
                    ) : row.org_name === null ? (
                      t('audit.deletedOrg', { id: row.org_id.slice(0, 8) })
                    ) : (
                      <Link
                        to="/platform/orgs/$orgId"
                        params={{ orgId: row.org_id }}
                        className="underline"
                      >
                        {row.org_name}
                      </Link>
                    )}
                  </td>
                  <td className="py-3 pr-4">{row.reason}</td>
                  <td className="py-3 pr-4">
                    {row.support_grant_id || row.break_glass_reason ? (
                      <div className="flex flex-col gap-1">
                        {row.support_grant_id ? (
                          <code>{row.support_grant_id.slice(0, 8)}</code>
                        ) : null}
                        {row.break_glass_reason ? (
                          <>
                            <Badge tone="danger">{t('audit.breakGlass')}</Badge>
                            <span>{row.break_glass_reason}</span>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                  <td className="py-3">
                    {Object.keys(row.target).length > 0 ? (
                      <details>
                        <summary>{t('audit.show')}</summary>
                        <pre className="max-w-80 overflow-x-auto text-sm">
                          {JSON.stringify(row.target, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}

      <nav className="flex gap-4" aria-label={t('audit.pages')}>
        {links.previous ? (
          <Link {...AUDIT} search={{ ...filters, ...links.previous }} className="underline">
            {t('audit.previous')}
          </Link>
        ) : null}
        {filter.after ? (
          <Link {...AUDIT} search={filters} className="underline">
            {t('audit.first')}
          </Link>
        ) : null}
        {links.next ? (
          <Link {...AUDIT} search={{ ...filters, ...links.next }} className="underline">
            {t('audit.next', { count: AUDIT_PAGE })}
          </Link>
        ) : null}
      </nav>

      <section aria-labelledby="audit-export" className="flex flex-col gap-3">
        <h2 id="audit-export" className="text-xl font-semibold">
          {t('audit.export.title')}
        </h2>
        <p className="text-muted">{t('audit.export.intro')}</p>
        <div>
          <Button
            variant="secondary"
            disabled={inverted}
            loading={exporting.isPending}
            loadingLabel={t('audit.export.working')}
            onClick={() => {
              setParts(0);
              exporting.mutate(undefined);
            }}
          >
            {t('audit.export.button')}
          </Button>
        </div>
        {exporting.isError ? (
          <p role="alert" className="font-medium text-danger-strong">
            {t(`audit.errors.${opsError(exporting.error)}`)}
          </p>
        ) : exported ? (
          <div role="status" className="flex flex-col gap-2">
            <p>
              {exported.rowCount === 0
                ? t('audit.export.none')
                : t('audit.export.done', { count: exported.rowCount })}
            </p>
            {exported.truncated && exported.nextAfter !== null ? (
              <>
                <p>{t('audit.export.truncated', { count: exported.rowCount })}</p>
                <div>
                  <Button
                    variant="secondary"
                    loading={exporting.isPending}
                    loadingLabel={t('audit.export.working')}
                    onClick={() => exporting.mutate(exported.nextAfter ?? undefined)}
                  >
                    {t('audit.export.next')}
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </section>
    </section>
  );
}
