import { Badge, Button, ConfirmDestructive, Input, PageHeader, Select, Skeleton } from '@qm/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { ScreenEmpty } from '../../../components/ScreenEmpty.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { countersQuery } from '../counters/api.ts';
import { canEditLocation } from '../location/api.ts';
import {
  devicesQuery,
  pairingCodeUsedQuery,
  useCreatePairingCode,
  useRevokeDevice,
  useSetDeviceCounter,
  type DeviceKind,
} from './api.ts';
import { countdown, deviceStatus, isConnecting, relativeAgo } from './status.ts';

const KNOWN_ERRORS = ['rate_limited', 'invalid_input', 'not_found'];

/** The current time, refreshed every `ms`. */
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/** Pair, watch and revoke the location's TVs and kiosks (D2, #49). Admins and owners only. */
export function DevicesPage() {
  const { t } = useTranslation('admin');
  const { location } = useCurrentLocation();
  const role = useCurrentOrg()?.role;
  if (!location) return <Skeleton label={t('devices.loading')} rows={2} />;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-8">
      <PageHeader title={t('devices.title')} />
      {canEditLocation(role) ? (
        <>
          <PairForm key={location.id} locationId={location.id} />
          <DeviceList locationId={location.id} />
        </>
      ) : (
        <p className="text-muted">{t('devices.adminsOnly')}</p>
      )}
    </div>
  );
}

function PairForm({ locationId }: { locationId: string }) {
  const { t } = useTranslation('admin');
  const create = useCreatePairingCode(locationId);
  const [kind, setKind] = useState<DeviceKind>('display');
  const [name, setName] = useState('');
  const now = useNow(1000);
  const left = create.data ? countdown(create.data.expires_at, now) : null;
  const used = useQuery({
    ...pairingCodeUsedQuery(create.data?.code ?? ''),
    enabled: !!left,
  }).data;
  // The new screen belongs in the list now, not after the list's next 30 s refresh.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (used) void queryClient.invalidateQueries({ queryKey: devicesQuery(locationId).queryKey });
  }, [used, queryClient, locationId]);
  const failure = create.error
    ? `devices.errors.${KNOWN_ERRORS.includes(create.error.message) ? create.error.message : 'unknown'}`
    : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({ kind, name });
  };

  return (
    <section className="flex flex-col gap-4" aria-labelledby="pair-heading">
      <h2 id="pair-heading" className="text-xl font-semibold">
        {t('devices.pair.title')}
      </h2>
      <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
        <Select
          label={t('devices.pair.kind')}
          value={kind}
          onChange={(event) => setKind(event.target.value as DeviceKind)}
        >
          <option value="display">{t('devices.kind.display')}</option>
          <option value="kiosk">{t('devices.kind.kiosk')}</option>
        </Select>
        <div className="min-w-60 flex-1">
          <Input
            label={t('devices.pair.name')}
            hint={t('devices.pair.nameHint')}
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <Button type="submit" loading={create.isPending} loadingLabel={t('devices.pair.creating')}>
          {t('devices.pair.create')}
        </Button>
      </form>
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(failure as 'devices.errors.unknown') : null}
      </p>
      {create.data ? (
        <div className="rounded-control border border-border p-4" data-testid="pairing-code">
          {used ? (
            <p role="status">{t('devices.pair.paired')}</p>
          ) : left ? (
            <>
              <p>
                {t('devices.pair.enterOn', {
                  url: new URL(`/${create.variables.kind}`, window.location.origin).href,
                })}
              </p>
              <p className="my-2 font-mono text-4xl font-bold tracking-widest">
                {create.data.code}
              </p>
              <p className="text-muted">{t('devices.pair.expiresIn', { time: left })}</p>
            </>
          ) : (
            <p>{t('devices.pair.expired')}</p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function DeviceList({ locationId }: { locationId: string }) {
  const { t, i18n } = useTranslation('admin');
  const query = useQuery(devicesQuery(locationId));
  const revoke = useRevokeDevice(locationId);
  const setCounter = useSetDeviceCounter(locationId);
  const counters = useQuery(countersQuery(locationId)).data ?? [];
  const now = useNow(15_000);
  const ago = new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' });

  if (!query.data) return <Skeleton label={t('devices.loading')} rows={2} />;
  return (
    <section className="flex flex-col gap-4" aria-labelledby="list-heading">
      <h2 id="list-heading" className="text-xl font-semibold">
        {t('devices.list.title')}
      </h2>
      {query.data.length === 0 ? (
        <ScreenEmpty kind="devices" />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {query.data.map((device) => {
            const status = deviceStatus(device.last_seen_at, now);
            const label = device.name || t(`devices.unnamed.${device.kind}`);
            return (
              <li
                key={device.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
                data-testid="device"
              >
                <div className="flex flex-col gap-1">
                  <p className="font-semibold">
                    {label}{' '}
                    <span className="font-normal text-muted">
                      {t(`devices.kind.${device.kind}`)}
                    </span>
                  </p>
                  <p className="flex flex-wrap items-center gap-2 text-muted">
                    {isConnecting(device, now) ? (
                      <Badge tone="info">{t('devices.list.connecting')}</Badge>
                    ) : (
                      <Badge tone={status.online ? 'success' : 'danger'}>
                        {t(status.online ? 'devices.list.online' : 'devices.list.offline')}
                      </Badge>
                    )}
                    {status.agoMs === undefined
                      ? t('devices.list.neverSeen')
                      : t('devices.list.lastSeen', {
                          ago: ago.format(
                            relativeAgo(status.agoMs).value,
                            relativeAgo(status.agoMs).unit,
                          ),
                        })}
                    {device.app_version
                      ? ` · ${t('devices.list.version', { version: device.app_version })}`
                      : null}
                    {device.realtime_drops > 0 && device.last_drop_at
                      ? ` · ${t('devices.list.drops', {
                          count: device.realtime_drops,
                          ago: ago.format(
                            relativeAgo(now - Date.parse(device.last_drop_at)).value,
                            relativeAgo(now - Date.parse(device.last_drop_at)).unit,
                          ),
                        })}`
                      : null}
                  </p>
                  {device.kind === 'display' ? (
                    <Select
                      label={t('devices.counter.label')}
                      value={device.counter_id ?? ''}
                      onChange={(event) =>
                        setCounter.mutate({
                          deviceId: device.id,
                          counterId: event.target.value || null,
                        })
                      }
                    >
                      <option value="">{t('devices.counter.none')}</option>
                      {counters.map((counter) => (
                        <option key={counter.id} value={counter.id}>
                          {counter.label}
                        </option>
                      ))}
                    </Select>
                  ) : null}
                </div>
                <ConfirmDestructive
                  triggerLabel={t('devices.revoke.trigger')}
                  title={t('devices.revoke.title', { name: label })}
                  description={t('devices.revoke.description')}
                  confirmLabel={t('devices.revoke.confirm')}
                  cancelLabel={t('devices.revoke.cancel')}
                  triggerVariant="secondary"
                  onConfirm={() => revoke.mutateAsync(device.id)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
