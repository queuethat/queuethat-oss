import { useDeliveryWarnings, useTextStates } from './messages/api.ts';
import { errorCode, formatLocalTime } from '@qm/domain';
import { useRef, useState } from 'react';
import type { CountryCode } from '@qm/ui/phone';
import {
  Badge,
  BigButton,
  Button,
  Card,
  ConnectionIndicator,
  EmptyState,
  Select,
  Spinner,
  Tabs,
  useToast,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../lib/translation.tsx';
import { useConnectionState } from '../../lib/live.ts';
import { useNow } from '../../lib/now.ts';
import { membersQuery } from '../admin/team/api.ts';
import { useSession } from '../auth/api.ts';
import { useCurrentLocation, useCurrentOrg } from '../auth/current.ts';
import { useGuestTagMap } from '../crm/tags/api.ts';
import {
  countersQuery,
  useCallNext,
  useMyPermissions,
  permittedActions,
  useConsoleQueues,
  useAssignVisit,
  useConsoleVisits,
  useDoneVisits,
  useBlockVisit,
  useGuestBadges,
  useMoveVisit,
  useTransferVisit,
  useAdvanceJourney,
  useUndo,
  useUpdateNotes,
  useVisitAction,
  type ConsoleQueue,
  type ConsoleVisit,
  type VisitAction,
  type VisitRow,
} from './api.ts';
import { chooseCounter, useMyCounter } from './counter.ts';
import { Broadcast } from './broadcast/BroadcastDialog.tsx';
import { WaitOverride } from './wait-override/WaitOverride.tsx';
import { QueueControls } from './QueueControls.tsx';
import { ScanDialog } from './scan/ScanDialog.tsx';
import { Timeline } from './timeline/Timeline.tsx';
import { ServingReminders } from './serving-reminder/ServingReminders.tsx';
import { useServingReminders } from './serving-reminder/useServingReminders.ts';
import { SoundAlerts } from './SoundAlerts.tsx';
import { VisitList, VisitListError } from './VisitList.tsx';
import { ConsoleSearch } from './search/ConsoleSearch.tsx';
import { applyFilters, useFilters } from './search/filters.ts';
import { assigneeLabel, type AssignTargets, type OnAssign } from './assign/AssignDialog.tsx';
import type { OnPriority } from './priority/PriorityDialog.tsx';
import { activeClassesQuery, useSetVisitPriority } from '../admin/priority/api.ts';
import type { OnTransfer } from './transfer/TransferDialog.tsx';
import type { OnSaveNotes } from './detail/VisitDetail.tsx';
import { DoneToday } from './history/DoneToday.tsx';
import { PresenceBar, useMyPresence } from './presence/PresenceBar.tsx';
import { AddGuest } from './AddGuest.tsx';
import { OfflinePanel } from './offline/OfflinePanel.tsx';
import {
  isQueued,
  type QueuedRow,
  useOfflineActions,
  useOfflineReplay,
  useOnline,
} from './offline/queue.ts';
import { ConsoleHints } from './hints/ConsoleHints.tsx';
import { ShortcutHelp } from './shortcuts/ShortcutHelp.tsx';
import { useShortcutsEnabled } from './shortcuts/preference.ts';
import { useShortcuts } from './shortcuts/useShortcuts.ts';
import { TodayPanel } from '../appointments/TodayPanel.tsx';
import { useLiveScreenActivity } from '../auth/SessionLimits.tsx';
import { useWakeLock } from '../display/useWakeLock.ts';
import { myLinesQuery } from './lines/api.ts';
import { callableCount } from './lines/lines.ts';
import { LinesBoard } from './lines/LinesBoard.tsx';

/** Roles that may block a guest (the database enforces the same ladder). */
const MANAGER_ROLES: string[] = ['manager', 'admin', 'owner'];

const PANEL_ID = 'console-queue';
const VIEWS = ['queue', 'timeline'] as const;

/** Actions whose result toast reads "Started A004." and so on; call has its own copy. */
type DoneAction = Exclude<VisitAction, 'call' | 'cancel' | 'expire'>;

/**
 * The staff console shell (C1, #58): queue tabs, this device's counter and whether the screen is
 * live. `queueId` comes from the address (`?queue=`), so a reload or a bookmark keeps the tab.
 */
export function ConsolePage({
  queueId,
  onQueueChange,
}: {
  queueId: string | undefined;
  onQueueChange: (queueId: string) => void;
}) {
  // A counter tablet watching the line isn't idle (see useLiveScreenActivity).
  useLiveScreenActivity();
  // ...and a sleeping counter tablet would miss new joiners, so keep the screen on.
  useWakeLock();
  const { t } = useTranslation('staff');
  const { location } = useCurrentLocation();
  const queues = useConsoleQueues(location?.id);
  const rawVisits = useConsoleVisits(location?.id);
  const offline = useOfflineActions();
  const online = useOnline();
  useOfflineReplay();
  // A visit with a stored action shows as pending and takes no further action until it replays:
  // its next action would carry a version the replay is about to change.
  const pendingIds = new Set(offline.actions.map((a) => a.visitId).filter((id) => id !== null));
  // A custom role can withhold calling and removing; the buttons for them disappear (4-RBAC2).
  const permissions = useMyPermissions(location?.org_id, location?.id).data;
  const mayCall = !permissions || permissions.includes('visits.call');
  const visits =
    pendingIds.size === 0 && !permissions
      ? rawVisits
      : {
          ...rawVisits,
          data: rawVisits.data?.map((v) =>
            pendingIds.has(v.id)
              ? { ...v, actions: [] }
              : { ...v, actions: permittedActions(v.actions, permissions) },
          ),
        };
  const done = useDoneVisits(location?.id);
  const [filters, setFilters] = useFilters(location?.id);
  const blockVisit = useBlockVisit();
  const org = useCurrentOrg();
  const reminders = useServingReminders(visits.data, queues.data);
  const deliveryWarnings = useDeliveryWarnings(location?.id);
  const textStates = useTextStates(location?.id);
  const badges = useGuestBadges((visits.data ?? []).map((v) => v.id));
  const guestTags = useGuestTagMap(
    (visits.data ?? []).flatMap((v) => (v.guestId ? [v.guestId] : [])),
  );
  const counters = useQuery({ ...countersQuery(location?.id ?? ''), enabled: !!location });
  const myCounter = useMyCounter(location?.id, counters.data ?? []);
  const onBreak = useMyPresence(location?.id)?.status === 'break';
  const connection = useConnectionState();
  // The database says until when; the page only stops showing it once that time has passed.
  const now = useNow(15_000);
  const [scanning, setScanning] = useState(false);
  const [view, setView] = useState<'queue' | 'timeline'>('queue');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [shortcutsOn, setShortcutsOn] = useShortcutsEnabled();
  // The newest undoable event this screen produced, for the U shortcut.
  const lastUndo = useRef<{ eventId: number; ticket: string } | null>(null);
  const pausedUntil = (q: ConsoleQueue) =>
    q.onlineJoinsPausedUntil && Date.parse(q.onlineJoinsPausedUntil) > now
      ? new Date(q.onlineJoinsPausedUntil)
      : null;
  const waitingCount = (id: string) =>
    visits.data?.filter((v) => v.queueId === id && v.status === 'waiting').length ?? 0;
  const toast = useToast();
  const callNext = useCallNext();
  const visitAction = useVisitAction();
  const undo = useUndo();
  const moveVisit = useMoveVisit();
  const updateNotes = useUpdateNotes();
  const transferVisit = useTransferVisit();
  const advanceJourney = useAdvanceJourney();
  const assignVisit = useAssignVisit();
  const setPriority = useSetVisitPriority();
  const priorityClasses = useQuery({
    ...activeClassesQuery(location?.id ?? ''),
    enabled: !!location,
  });
  const userId = useSession().data?.user.id;
  const members = useQuery({ ...membersQuery(location?.org_id ?? ''), enabled: !!location });
  const myLines = useQuery({ ...myLinesQuery(location?.org_id ?? ''), enabled: !!location });
  // Without ?queue=, a provider (M6) opens on their own line.
  const currentQueue = () =>
    queues.data?.find((q) => q.id === queueId) ??
    queues.data?.find((q) => q.kind === 'provider' && myLines.data?.queueIds?.includes(q.id)) ??
    queues.data?.[0];
  // A provider line also reaches its pool (M4), so either having someone enables Call next.
  const nobodyToCall = (q: ConsoleQueue) => callableCount(q, visits.data ?? []) === 0;
  const callNextOn = (id: string) =>
    callNext.mutate(
      { queueId: id, counterId: myCounter },
      { onSuccess: (row) => announce('call', row), onError: failed },
    );
  // Every action answers with what happened and an Undo for 10 s (S-6); the database decides
  // whether the undo still applies.
  const announce = (action: VisitAction, row: VisitRow | QueuedRow | null) => {
    if (isQueued(row)) {
      return toast.show({ message: t('console.offline.saved', { ticket: row.display_ticket }) });
    }
    if (!row?.display_ticket) return toast.show({ message: t('console.nobodyWaiting') });
    const ticket = row.display_ticket;
    const counter = counters.data?.find((c) => c.id === myCounter)?.label;
    const message =
      action === 'call'
        ? counter
          ? t('console.calledTo', { ticket, counter })
          : t('console.called', { ticket })
        : t(`console.done.${action as DoneAction}`, { ticket });
    const eventId = row.last_event_id;
    if (eventId == null) return toast.show({ message, tone: 'success' });
    lastUndo.current = { eventId, ticket };
    toast.undo(message, () =>
      undo.mutate(eventId, {
        onSuccess: () => toast.show({ message: t('console.undone', { ticket }) }),
        onError: (error) =>
          toast.show(
            errorCode(error) === 'undo_not_allowed'
              ? { message: t('console.undoTooLate', { ticket }) }
              : errorCode(error) === 'org_suspended'
                ? { message: t('console.suspended'), tone: 'danger' }
                : { message: t('console.actionFailed'), tone: 'danger' },
          ),
      }),
    );
  };
  const saveNotes: OnSaveNotes = (visit, notes, tags) =>
    updateNotes.mutateAsync({ visit, notes, tags }).then(
      () => {
        toast.show({
          message: t('console.detail.saved', { ticket: visit.ticket }),
          tone: 'success',
        });
        return true;
      },
      (error) => {
        failed(error);
        return false;
      },
    );
  const transfer: OnTransfer = (visit, toQueueId, toServiceId) =>
    transferVisit.mutateAsync({ visit, toQueueId, toServiceId }).then(
      (row) => {
        const to = queues.data?.find((q) => q.id === toQueueId)?.name ?? '';
        const message = t('console.transfer.done', {
          ticket: row.display_ticket ?? visit.ticket,
          queue: to,
        });
        if (row.last_event_id == null) toast.show({ message, tone: 'success' });
        else
          toast.undo(message, () =>
            undo.mutate(row.last_event_id!, {
              onSuccess: () =>
                toast.show({ message: t('console.undone', { ticket: visit.ticket }) }),
              onError: () =>
                toast.show({ message: t('console.undoTooLate', { ticket: visit.ticket }) }),
            }),
          );
        return true;
      },
      (error) => {
        if (errorCode(error) === 'queue_not_accepting') {
          toast.show({ message: t('console.transfer.notAccepting'), tone: 'danger' });
        } else failed(error);
        return false;
      },
    );
  const advance = (visit: ConsoleVisit) =>
    advanceJourney.mutateAsync({ visit }).then((row) => {
      const to = queues.data?.find((q) => q.id === row.queue_id)?.name ?? '';
      const message = t('console.journey.done', { ticket: visit.ticket, queue: to });
      lastUndo.current =
        row.last_event_id == null ? null : { eventId: row.last_event_id, ticket: visit.ticket };
      if (row.last_event_id == null) toast.show({ message, tone: 'success' });
      else
        toast.undo(message, () =>
          undo.mutate(row.last_event_id!, {
            onSuccess: () => toast.show({ message: t('console.undone', { ticket: visit.ticket }) }),
            onError: () =>
              toast.show({ message: t('console.undoTooLate', { ticket: visit.ticket }) }),
          }),
        );
    }, failed);
  // People who can take a guest here: members of this location (null location list = all of them).
  const assignTargets: AssignTargets = {
    counters: counters.data ?? [],
    staff: (members.data ?? [])
      .filter(
        (m) => m.userId && (m.locationIds === null || m.locationIds.includes(location?.id ?? '')),
      )
      .map((m) => ({
        userId: m.userId!,
        name: m.displayName ?? m.email?.split('@')[0] ?? t('console.assign.someone'),
      })),
  };
  const assign: OnAssign = (visit, counterId, staffUserId) =>
    assignVisit.mutateAsync({ visit, counterId, staffUserId }).then(
      () => {
        toast.show({
          message:
            counterId || staffUserId
              ? t('console.assign.done', {
                  ticket: visit.ticket,
                  who: assigneeLabel(
                    { assignedStaffId: staffUserId, assignedCounterId: counterId },
                    assignTargets,
                    t('console.assign.someone'),
                  ),
                })
              : t('console.assign.cleared', { ticket: visit.ticket }),
          tone: 'success',
        });
        return true;
      },
      (error) => {
        // The person or counter doesn't cover this guest, or left: the database says not_found.
        toast.show(
          errorCode(error) === 'not_found'
            ? { message: t('console.assign.notCovered'), tone: 'danger' }
            : errorCode(error) === 'stale_visit'
              ? { message: t('console.stale') }
              : { message: t('console.actionFailed'), tone: 'danger' },
        );
        return false;
      },
    );
  const onPriority: OnPriority = (visit, classId) =>
    setPriority.mutateAsync({ visitId: visit.id, classId, version: visit.version }).then(
      () => {
        toast.show({
          message: classId
            ? t('console.priority.done', {
                ticket: visit.ticket,
                name: priorityClasses.data?.find((c) => c.id === classId)?.name ?? '',
              })
            : t('console.priority.cleared', { ticket: visit.ticket }),
          tone: 'success',
        });
        return true;
      },
      (error) => {
        toast.show(
          errorCode(error) === 'stale_visit'
            ? { message: t('console.stale') }
            : { message: t('console.priority.failed'), tone: 'danger' },
        );
        return false;
      },
    );
  const announceMove = (ticket: string, eventId: number) =>
    toast.undo(t('console.reorder.moved', { ticket }), () =>
      undo.mutate(eventId, {
        onSuccess: () => toast.show({ message: t('console.undone', { ticket }) }),
        onError: () => toast.show({ message: t('console.undoTooLate', { ticket }) }),
      }),
    );
  // stale_visit: another tablet got there first; the list has refetched, so say so calmly.
  const failed = (error: unknown) =>
    toast.show(
      errorCode(error) === 'stale_visit'
        ? { message: t('console.stale') }
        : errorCode(error) === 'org_suspended'
          ? { message: t('console.suspended'), tone: 'danger' }
          : { message: t('console.actionFailed'), tone: 'danger' },
    );

  useShortcuts(shortcutsOn, (command) => {
    const current = currentQueue();
    if (!location || !current || view !== 'queue') return;
    const inView = applyFilters(
      (visits.data ?? []).filter((v) => v.queueId === current.id),
      filters,
      { userId, counterId: myCounter },
    );
    // On-screen order: waiting, then called, then serving.
    const ordered = ['waiting', 'called', 'serving'].flatMap((s) =>
      inView.filter((v) => v.status === s),
    );
    const selected = ordered.find((v) => v.id === selectedId);
    const act = (action: VisitAction) => {
      // The row's own allowed_actions decide; an illegal key press does nothing.
      if (!selected?.actions.includes(action) || visitAction.isPending) return;
      visitAction
        .mutateAsync({ visit: selected, action, counterId: myCounter })
        .then((row) => announce(action, row), failed);
    };
    const confirmFor = (action: 'no_show' | 'remove') => {
      if (!selected?.actions.includes(action)) return;
      // Opens the row's normal ConfirmDestructive; the shortcut never acts on its own.
      document
        .querySelector<HTMLElement>(
          `[aria-label="${CSS.escape(t(`console.actionLabel.${action}`, { ticket: selected.ticket }))}"]`,
        )
        ?.click();
    };
    const step = (by: 1 | -1) => {
      if (ordered.length === 0) return;
      const at = selected ? ordered.indexOf(selected) : -1;
      const next = ordered[Math.min(ordered.length - 1, Math.max(0, at + by))];
      if (next) setSelectedId(next.id);
    };
    const click = (selector: string) => document.querySelector<HTMLElement>(selector)?.click();
    switch (command) {
      case 'callNext':
        if (mayCall && online && !nobodyToCall(current) && !callNext.isPending)
          callNextOn(current.id);
        return;
      case 'selectNext':
        return step(1);
      case 'selectPrevious':
        return step(-1);
      case 'start':
        return act('start');
      case 'complete':
        return act('complete');
      case 'recall':
        return act('recall');
      case 'noShow':
        return confirmFor('no_show');
      case 'remove':
        return confirmFor('remove');
      case 'undo': {
        const last = lastUndo.current;
        if (!last) return;
        lastUndo.current = null;
        undo.mutate(last.eventId, {
          onSuccess: () => toast.show({ message: t('console.undone', { ticket: last.ticket }) }),
          onError: () => toast.show({ message: t('console.undoTooLate', { ticket: last.ticket }) }),
        });
        return;
      }
      case 'addGuest':
        return click('[data-shortcut="add-guest"]');
      case 'search':
        return document.querySelector<HTMLElement>('[data-shortcut="search"]')?.focus();
      case 'help':
        return setHelpOpen(true);
    }
  });

  if (!location || !queues.data || !counters.data) {
    return <Spinner label={t('console.loading')} className="mx-auto my-16" />;
  }
  const queue = currentQueue();
  const inQueue = visits.data?.filter((v) => v.queueId === queue?.id) ?? [];
  const waitingIn = waitingCount;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{t('console.title')}</h1>
          <ConnectionIndicator state={connection} label={t(`console.connection.${connection}`)} />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Button variant="secondary" onClick={() => setScanning(true)}>
            {t('console.scan.open')}
          </Button>
          <div className="w-64">
            <Select
              label={t('console.counter.label')}
              hint={myCounter ? undefined : t('console.counter.hint')}
              value={myCounter ?? ''}
              onChange={(event) => chooseCounter(location.id, event.target.value)}
            >
              {myCounter ? null : (
                <option value="" disabled>
                  {t('console.counter.placeholder')}
                </option>
              )}
              {counters.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </div>
      <ConsoleHints />

      <PresenceBar
        locationId={location.id}
        counterId={myCounter ?? null}
        counterLabels={new Map((counters.data ?? []).map((c) => [c.id, c.label]))}
      />

      <ShortcutHelp
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        enabled={shortcutsOn}
        onEnabled={setShortcutsOn}
      />
      <SoundAlerts visits={visits.data} reminderIds={reminders.overdue.map((o) => o.id)} />

      <ScanDialog
        open={scanning}
        onClose={() => setScanning(false)}
        locationId={location.id}
        visits={visits.data ?? []}
        busy={visitAction.isPending ? visitAction.variables.visit.id : null}
        onAction={(visit, action) =>
          visitAction
            .mutateAsync({ visit, action, counterId: myCounter })
            .then((row) => announce(action, row), failed)
        }
      />

      <div role="group" aria-label={t('console.timeline.view')} className="flex gap-2">
        {VIEWS.map((id) => (
          <Button
            key={id}
            variant={view === id ? 'primary' : 'secondary'}
            aria-pressed={view === id}
            onClick={() => setView(id)}
          >
            {t(id === 'queue' ? 'console.timeline.queueTab' : 'console.timeline.tab')}
          </Button>
        ))}
      </div>
      <div className="contents">
        {view === 'timeline' ? (
          <Timeline
            visits={visits.data ?? []}
            timeZone={location.tz}
            now={now}
            busy={visitAction.isPending ? visitAction.variables.visit.id : null}
            onCheckIn={(visit) =>
              void visitAction
                .mutateAsync({ visit, action: 'check_in', counterId: myCounter })
                .then((row) => announce('check_in', row), failed)
            }
          />
        ) : queue ? (
          <>
            <LinesBoard
              queues={queues.data}
              visits={visits.data ?? []}
              mine={myLines.data}
              currentId={queue.id}
              mayCall={mayCall}
              disabled={!online || onBreak}
              calling={callNext.isPending ? callNext.variables.queueId : null}
              onCallNext={callNextOn}
              onOpen={onQueueChange}
            />
            <Tabs
              label={t('console.queues')}
              panelId={PANEL_ID}
              value={queue.id}
              onChange={onQueueChange}
              items={queues.data.map((q) => ({
                id: q.id,
                label: q.name,
                extra: (
                  <>
                    {visits.data ? (
                      <Badge aria-label={t('console.waitingCount', { count: waitingIn(q.id) })}>
                        {waitingIn(q.id)}
                      </Badge>
                    ) : null}
                    {q.manualState === 'open' ? null : (
                      <Badge tone="warning">{t(`console.state.${q.manualState}`)}</Badge>
                    )}
                    {q.manualState === 'open' && pausedUntil(q) ? (
                      <Badge tone="warning">{t('console.state.onlineFull')}</Badge>
                    ) : null}
                  </>
                ),
              }))}
            />
            <div id={PANEL_ID} role="tabpanel" aria-labelledby={`tab-${queue.id}`}>
              {offline.available ? null : (
                <Card role="alert" className="mb-4 bg-warning-soft text-warning-strong">
                  {t('console.offline.unavailable')}
                </Card>
              )}
              <OfflinePanel visits={visits.data ?? []} />
              {online ? null : (
                <Card role="status" className="mb-4 bg-warning-soft text-warning-strong">
                  {t('console.offline.needsConnection')}
                </Card>
              )}
              <OnlineJoinsPaused until={pausedUntil(queue)} timeZone={location.tz} />
              <WaitOverride
                key={`wait-banner-${queue.id}`}
                part="banner"
                queue={queue}
                timeZone={location.tz}
              />
              <div className="mb-4 grid grid-cols-[2fr_1fr] gap-4">
                {mayCall ? (
                  <BigButton
                    disabled={nobodyToCall(queue) || !online || onBreak}
                    loading={callNext.isPending}
                    loadingLabel={t('console.calling')}
                    onClick={() => callNextOn(queue.id)}
                  >
                    {t('console.callNext')}
                  </BigButton>
                ) : null}
                {onBreak && <p className="col-span-2 text-sm">{t('presence.callDisabled')}</p>}
                <AddGuest
                  queue={queue}
                  country={(location.country_code as CountryCode | null) ?? 'US'}
                  priorityClasses={priorityClasses.data}
                />
              </div>
              <ServingReminders
                overdue={reminders.overdue}
                visits={inQueue}
                busy={visitAction.isPending ? visitAction.variables.visit.id : null}
                onSnooze={reminders.snooze}
                onComplete={(visit) =>
                  void visitAction
                    .mutateAsync({ visit, action: 'complete', counterId: myCounter })
                    .then((row) => announce('complete', row), failed)
                }
              />
              <ConsoleSearch
                locationId={location.id}
                timeZone={location.tz}
                services={[
                  ...new Set([...inQueue.map((v) => v.service), ...filters.services]),
                ].filter((x): x is string => !!x)}
                tags={[...new Set([...inQueue.flatMap((v) => v.tags), ...filters.tags])]}
                filters={filters}
                onFilters={setFilters}
                onSaveNotes={saveNotes}
              />
              {visits.data ? (
                <VisitList
                  selectedId={selectedId}
                  pendingIds={pendingIds}
                  visits={applyFilters(inQueue, filters, { userId, counterId: myCounter })}
                  timeZone={location.tz}
                  busy={visitAction.isPending ? visitAction.variables.visit.id : null}
                  badges={badges.data}
                  deliveryWarnings={deliveryWarnings}
                  textStates={textStates}
                  guestTags={guestTags.data}
                  onBlock={
                    org && MANAGER_ROLES.includes(org.role)
                      ? (visit, reason, days) =>
                          blockVisit
                            .mutateAsync({ visit, reason, days })
                            .then(() =>
                              visitAction.mutateAsync({
                                visit,
                                action: 'remove',
                                counterId: myCounter,
                                reason,
                              }),
                            )
                            .then(
                              (row) => announce('remove', row),
                              (error: unknown) =>
                                errorCode(error) === 'invalid_input'
                                  ? toast.show({
                                      message: t('console.block.nothing'),
                                      tone: 'danger',
                                    })
                                  : failed(error),
                            )
                      : undefined
                  }
                  // Resolves either way, so a confirm dialog closes; failures show as a toast.
                  // Optimistic order is not worth the risk: the list is live and the move is fast.
                  onMove={(visit, afterId) =>
                    moveVisit.mutateAsync({ visit, afterId }).then((row) => {
                      // A no-op (already there) has no event to undo.
                      if (row?.last_event_id != null) announceMove(visit.ticket, row.last_event_id);
                    }, failed)
                  }
                  onSaveNotes={saveNotes}
                  onTransfer={transfer}
                  onAdvance={advance}
                  onAssign={assign}
                  assignTargets={assignTargets}
                  onPriority={onPriority}
                  priorityClasses={priorityClasses.data}
                  queues={queues.data}
                  onAction={(visit, action, reason) =>
                    visitAction
                      .mutateAsync({ visit, action, counterId: myCounter, reason })
                      .then((row) => announce(action, row), failed)
                  }
                />
              ) : visits.isError ? (
                <VisitListError onRetry={() => void visits.refetch()} />
              ) : (
                <Spinner label={t('console.loadingList')} className="mx-auto my-8" />
              )}
              <DoneToday visits={done.data ?? []} timeZone={location.tz} />
              <section aria-labelledby="queue-tools" className="mt-8">
                <h2 id="queue-tools" className="mb-3 text-lg font-semibold">
                  {t('console.toolsTitle')}
                </h2>
                <QueueControls
                  key={queue.id}
                  queue={queue}
                  locationId={location.id}
                  disabled={!online}
                />
                <WaitOverride
                  key={`wait-${queue.id}`}
                  part="action"
                  queue={queue}
                  timeZone={location.tz}
                />
                <Broadcast
                  key={`broadcast-${queue.id}`}
                  queue={queue}
                  reachable={
                    visits.data?.filter(
                      (v) =>
                        v.queueId === queue.id && (v.status === 'waiting' || v.status === 'called'),
                    ).length ?? 0
                  }
                />
              </section>
            </div>
          </>
        ) : (
          <EmptyState title={t('console.noQueues')} />
        )}
      </div>
      <TodayPanel locationId={location.id} tz={location.tz} />
    </div>
  );
}

/**
 * #492: the queue reached its hourly online-join ceiling, so guests on the poster are sent to
 * the desk until `until`. Staff add them here meanwhile.
 */
function OnlineJoinsPaused({ until, timeZone }: { until: Date | null; timeZone: string }) {
  const { t, i18n } = useTranslation('staff');
  if (!until) return null;
  const time = formatLocalTime(until, timeZone, i18n.language);
  return (
    <Card role="status" className="mb-4 bg-warning-soft text-warning-strong">
      {t('console.onlineJoinsPaused', { time })}
    </Card>
  );
}
