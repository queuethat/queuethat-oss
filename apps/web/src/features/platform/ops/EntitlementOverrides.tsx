import type { Json } from '@qm/db-types';
import { Button, ConfirmDestructive, EmptyState, Input, Select, Spinner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { opsError, orgEntitlementsQuery, useSetEntitlement } from './api.ts';

/** The typed value as JSON, or undefined when it doesn't parse. */
export function parseValue(text: string): Json | undefined {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

/**
 * Entitlement overrides on the platform org detail (PLT13, #419): every key with its default and
 * this org's value, and a form to set or clear one with a reason. The database resolves and
 * audits; this only edits the override row.
 */
export function EntitlementOverrides({ orgId }: { orgId: string }) {
  const { t } = useTranslation('platform');
  const entitlements = useQuery(orgEntitlementsQuery(orgId));
  const set = useSetEntitlement(orgId);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [noReason, setNoReason] = useState(false);

  if (!entitlements.data) {
    return entitlements.isError ? (
      <EmptyState title={t('ops.loadFailed')} />
    ) : (
      <Spinner label={t('ops.loading')} />
    );
  }
  const { defaults, overrides } = entitlements.data;
  const override = (k: string) => overrides.find((o) => o.key === k);
  const chosen = key || defaults[0]?.key || '';
  const failure = set.error ? t(`ops.entitlements.errors.${opsError(set.error)}`) : null;
  const done = () => {
    setValue('');
    setReason('');
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseValue(value);
    setNoReason(reason.trim() === '');
    setInvalid(parsed === undefined);
    if (parsed !== undefined && reason.trim() !== '')
      set.mutate({ key: chosen, value: parsed, reason }, { onSuccess: done });
  };

  return (
    <section aria-labelledby="entitlements" className="flex flex-col gap-4">
      <h2 id="entitlements" className="text-xl font-semibold">
        {t('ops.entitlements.title')}
      </h2>
      {defaults.length === 0 ? (
        <EmptyState title={t('ops.entitlements.none')} />
      ) : (
        <>
          <table className="w-full text-left">
            <thead>
              <tr>
                <th scope="col">{t('ops.entitlements.key')}</th>
                <th scope="col">{t('ops.entitlements.default')}</th>
                <th scope="col">{t('ops.entitlements.override')}</th>
                <th scope="col">{t('ops.entitlements.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {defaults.map((d) => (
                <tr key={d.key}>
                  <th scope="row" className="font-mono font-normal" title={d.description}>
                    {d.key}
                  </th>
                  <td className="font-mono">{JSON.stringify(d.value)}</td>
                  <td className="font-mono">
                    {override(d.key)
                      ? JSON.stringify(override(d.key)!.value)
                      : t('ops.entitlements.inherited')}
                  </td>
                  <td>{override(d.key)?.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <Select
              label={t('ops.entitlements.key')}
              value={chosen}
              onChange={(e) => setKey(e.target.value)}
            >
              {defaults.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.key}
                </option>
              ))}
            </Select>
            <Input
              label={t('ops.entitlements.value')}
              hint={t('ops.entitlements.valueHint')}
              error={invalid ? t('ops.entitlements.errors.json') : undefined}
              className="font-mono"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setInvalid(false);
              }}
              required
            />
            <Input
              label={t('ops.entitlements.reason')}
              error={noReason ? t('ops.entitlements.errors.reason') : undefined}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setNoReason(false);
              }}
              required
            />
            <p role="alert" className="font-medium text-danger-strong empty:hidden">
              {failure}
            </p>
            <div className="flex flex-wrap gap-3">
              <Button type="submit" loading={set.isPending} loadingLabel={t('ops.saving')}>
                {t('ops.entitlements.save')}
              </Button>
              <ConfirmDestructive
                triggerVariant="secondary"
                triggerLabel={t('ops.entitlements.clear')}
                title={t('ops.entitlements.clearTitle', { key: chosen })}
                description={t('ops.entitlements.clearDescription')}
                confirmLabel={t('ops.entitlements.clearConfirm')}
                cancelLabel={t('ops.cancel')}
                disabled={!override(chosen) || !reason.trim()}
                onConfirm={() =>
                  set.mutateAsync({ key: chosen, value: null, reason }).then(done, () => {})
                }
              />
            </div>
          </form>
        </>
      )}
    </section>
  );
}
