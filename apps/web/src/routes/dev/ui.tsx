import { createFileRoute, notFound } from '@tanstack/react-router';
import {
  Badge,
  BarChart,
  BigButton,
  Button,
  Skeleton,
  Stepper,
  iconUsers,
  LinkButton,
  Card,
  ConfirmDestructive,
  Checkbox,
  ConnectionIndicator,
  DataTable,
  Dialog,
  EmptyState,
  Icon,
  Mark,
  Input,
  Menu,
  PageHeader,
  Popover,
  SectionNav,
  RadioGroup,
  Segmented,
  Select,
  Spinner,
  Switch,
  StatusPill,
  TicketNumber,
  ToastProvider,
  useToast,
  type ConnectionState,
  type IconDef,
  type Tone,
  type VisitStatus,
} from '@qm/ui';
import * as kit from '@qm/ui';
import { PhoneInput } from '@qm/ui/phone';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';

// Component catalogue for packages/ui: every component and variant, in both themes. It is the
// reference agents build screens from, and the page axe checks (F8, #18). Developer-only, so
// its strings are not translated. Dev builds only: production answers 404, and the component is
// replaced so the catalogue is dropped from the bundle.
export const Route = createFileRoute('/dev/ui')({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: import.meta.env.DEV ? Catalogue : () => null,
});

const statuses: VisitStatus[] = [
  'expected',
  'waiting',
  'called',
  'serving',
  'served',
  'no_show',
  'cancelled',
  'removed',
  'expired',
];
const tones: Tone[] = ['neutral', 'info', 'success', 'warning', 'danger'];
const connections: ConnectionState[] = ['live', 'connecting', 'offline'];

function Catalogue() {
  return (
    <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss" undoLabel="Undo">
      <main className="mx-auto flex max-w-4xl flex-col gap-8 p-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-3xl font-bold">UI catalogue</h1>
          <ThemeSwitch />
        </header>

        <Section title="Button">
          <div className="flex flex-wrap gap-3">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="destructive">Destructive</Button>
            <Button disabled>Disabled</Button>
            <Button loading loadingLabel="Saving">
              Saving
            </Button>
          </div>
        </Section>

        <Section title="LinkButton (navigation that looks like a button)">
          <div className="flex flex-wrap gap-3">
            <LinkButton href="#link-button">Primary link</LinkButton>
            <LinkButton variant="secondary" href="#link-button">
              Secondary link
            </LinkButton>
          </div>
        </Section>

        <Section title="BigButton (staff and kiosk, 56px)">
          <div className="grid gap-3 sm:grid-cols-3">
            <BigButton>Call next</BigButton>
            <BigButton variant="secondary">Recall</BigButton>
            <BigButton variant="destructive">No-show</BigButton>
          </div>
        </Section>

        <Section title="Input and Select">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Name" hint="Shown to staff only" autoComplete="name" />
            <Input label="Party size" type="number" error="Enter a number from 1 to 20" />
            <Select label="Service" defaultValue="cut">
              <option value="cut">Haircut</option>
              <option value="beard">Beard trim</option>
            </Select>
            <Input label="Disabled" disabled defaultValue="Read only" />
            <Checkbox label="Show first names on the TV" hint="Off by default" />
          </div>
        </Section>

        <Section title="PhoneInput">
          <PhoneDemo />
        </Section>

        <Section title="Sortable list">
          <Suspense fallback={<Spinner label="Loading" />}>
            <SortableDemo />
          </Suspense>
        </Section>

        <Section title="Dialog">
          <DialogDemo />
        </Section>

        <Section title="ConfirmDestructive">
          <div className="flex flex-wrap gap-3">
            <ConfirmDestructive
              triggerLabel="Remove A012"
              title="Remove A012 from the queue?"
              description="They lose their place. You can undo for 10 minutes."
              confirmLabel="Yes, remove"
              cancelLabel="Keep in queue"
              onConfirm={() => new Promise((resolve) => setTimeout(resolve, 600))}
            />
            <ConfirmDestructive
              triggerVariant="secondary"
              triggerLabel="Close queue"
              title="Close the queue?"
              description="Nobody new can join until you reopen it."
              confirmLabel="Close queue"
              cancelLabel="Keep open"
              onConfirm={() => {}}
            />
          </div>
        </Section>

        <Section title="Toast and UndoToast">
          <ToastDemo />
        </Section>

        <Section title="Card">
          <Card className="flex items-center justify-between gap-4">
            <div>
              <p className="text-2xl font-bold">A012</p>
              <p className="text-muted">Haircut · party of 2 · waiting 12 min</p>
            </div>
            <StatusPill status="waiting">Waiting</StatusPill>
          </Card>
        </Section>

        <Section title="TicketNumber">
          <div className="flex flex-wrap items-baseline gap-6">
            {(['phone', 'tablet', 'tv', 'print'] as const).map((size) => (
              <div key={size}>
                <TicketNumber ticket="A007" size={size} />
                <p className="text-muted">{size}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Badge and StatusPill">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {tones.map((tone) => (
                <Badge key={tone} tone={tone}>
                  {tone}
                </Badge>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {statuses.map((status) => (
                <StatusPill key={status} status={status}>
                  {status.replace('_', ' ')}
                </StatusPill>
              ))}
            </div>
          </div>
        </Section>

        <Section title="EmptyState">
          <EmptyState
            title="Nobody is waiting"
            description="New guests appear here as they join."
            action={<Button variant="secondary">Add a walk-in</Button>}
          />
        </Section>

        <Section title="EmptyState with icon and reason">
          <EmptyState
            icon={iconUsers}
            title="No guests yet"
            description="People appear here after they join a line."
            reason="We keep each visit so you can recognise regulars."
            action={<Button>Share your join link</Button>}
            secondary={<Button variant="secondary">Print poster</Button>}
          />
        </Section>

        <Section title="DataTable">
          <DataTable
            label="Guests in line"
            scrollLabel="Guests in line, scrollable"
            getRowKey={(r) => r.ticket}
            columns={[
              { id: 'ticket', header: 'Ticket', cell: (r) => <TicketNumber ticket={r.ticket} /> },
              { id: 'name', header: 'Guest', cell: (r) => r.name },
              {
                id: 'status',
                header: 'Status',
                cell: (r) => <StatusPill status={r.status}>{r.status}</StatusPill>,
              },
              { id: 'wait', header: 'Wait', align: 'end', cell: (r) => r.wait },
            ]}
            rows={[
              { ticket: 'A012', name: 'Ana', status: 'waiting' as VisitStatus, wait: '12 min' },
              { ticket: 'A013', name: 'Ben', status: 'called' as VisitStatus, wait: '15 min' },
            ]}
          />
        </Section>

        <Section title="Switch, RadioGroup and Segmented">
          <ChoiceDemo />
        </Section>

        <Section title="Stepper">
          <Stepper
            label="Setup progress"
            steps={['Business', 'Location', 'First queue']}
            current={1}
          />
        </Section>

        <Section title="Skeleton">
          <Skeleton label="Loading" rows={3} />
        </Section>

        <Section title="BarChart">
          <BarChart
            label="Joins per day, last 7 days"
            bars={[4, 9, 2, 0, 12, 7, 5].map((value, i) => ({
              key: String(i),
              label: `Day ${i + 1}: ${value}`,
              value,
            }))}
          />
        </Section>

        <Section title="Icon (decorative by default; label when standalone)">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-3">
            {Object.entries(kit)
              .filter(([name]) => name.startsWith('icon'))
              .map(([name, d]) => (
                <div key={name} className="flex flex-col items-center gap-1 text-sm text-muted">
                  <Icon icon={d as IconDef} size="lg" className="text-fg" />
                  {name.slice(4)}
                </div>
              ))}
          </div>
          <div className="flex items-center gap-3">
            <Icon icon={kit.iconWifiOff} label="Offline" size="lg" />
            <span className="text-sm text-muted">Standalone icon with a label</span>
          </div>
        </Section>

        <Section title="Mark (fixed brand fills; decorative beside the wordmark, labelled alone)">
          <div className="flex flex-wrap items-end gap-6">
            {[16, 24, 36, 64].map((size) => (
              <div key={size} className="flex flex-col items-center gap-1 text-sm text-muted">
                <Mark size={size} />
                {size}
              </div>
            ))}
            <span className="flex items-center gap-3 text-2xl font-semibold tracking-[-0.03em]">
              <Mark size={36} />
              <span>QueueThat</span>
            </span>
          </div>
        </Section>

        <Section title="PageHeader and SectionNav (AppShell frames them in /admin)">
          <PageHeader
            title="Hours"
            description="When guests can join. Times use the location's time zone."
            breadcrumbs={[{ label: 'Location' }, { label: 'Hours' }]}
            breadcrumbLabel="Breadcrumb"
            actions={<Button>Save hours</Button>}
          />
          <div className="max-w-64">
            <SectionNav
              label="Example navigation"
              currentId="hours"
              groups={[
                {
                  id: 'today',
                  label: 'Today',
                  items: [{ id: 'today', label: 'Today', icon: kit.iconHome }],
                },
                {
                  id: 'setup',
                  label: 'Set up',
                  items: [{ id: 'hours', label: 'Hours', icon: kit.iconClock }],
                },
                {
                  id: 'danger',
                  items: [{ id: 'danger', label: 'Danger zone', icon: kit.iconAlertTriangle }],
                },
              ]}
              renderItem={(item, view) => (
                <a
                  href={`#${item.id}`}
                  className={view.className}
                  aria-current={view.current ? 'page' : undefined}
                >
                  {view.content}
                </a>
              )}
            />
          </div>
        </Section>

        <Section title="Menu and Popover (row overflow: one visible action, the rest here)">
          <div className="flex items-center gap-3">
            <Button>Call</Button>
            <Menu
              label="More actions for A-042"
              items={[
                { id: 'move', label: 'Move', icon: kit.iconArrowRight, onSelect: () => undefined },
                {
                  id: 'priority',
                  label: 'Priority',
                  icon: kit.iconBell,
                  onSelect: () => undefined,
                },
                {
                  id: 'remove',
                  label: 'Remove',
                  icon: kit.iconTrash,
                  confirm: {
                    title: 'Remove Maya, A-042?',
                    confirmLabel: 'Remove',
                    cancelLabel: 'Keep',
                    onConfirm: () => undefined,
                  },
                },
              ]}
            />
            <Popover triggerLabel="Filters" trigger="Filters">
              <p className="text-sm text-muted">Any small form or preview goes in a popover.</p>
            </Popover>
          </div>
        </Section>

        <Section title="Spinner">
          <Spinner label="Loading" />
        </Section>

        <Section title="ConnectionIndicator">
          <div className="flex flex-wrap gap-3">
            {connections.map((state) => (
              <ConnectionIndicator key={state} state={state} label={state} />
            ))}
          </div>
        </Section>

        <Section title="Type scale">
          <p className="text-display font-bold">A012</p>
          <p className="text-2xl">Text 2xl</p>
          <p className="text-base">Text base</p>
          <p className="text-sm text-muted">Text sm, muted</p>
        </Section>
      </main>
    </ToastProvider>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function ThemeSwitch() {
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system');
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);
  return (
    <div className="flex gap-2">
      {(['system', 'light', 'dark'] as const).map((option) => (
        <Button
          key={option}
          variant={theme === option ? 'primary' : 'secondary'}
          aria-pressed={theme === option}
          onClick={() => setTheme(option)}
        >
          {option[0]!.toUpperCase() + option.slice(1)}
        </Button>
      ))}
    </div>
  );
}

// Lazy on purpose: the sortable primitive must never land in the guest bundle.
const SortableDemo = lazy(() => import('./-sortable-demo.tsx'));

function PhoneDemo() {
  const [e164, setE164] = useState<string | null>(null);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-2">
        <PhoneInput
          label="Mobile number"
          countryLabel="Country"
          defaultCountry="US"
          hint="Optional. We text you when it's your turn."
          onChange={setE164}
        />
        <p className="text-sm text-muted">
          E.164: <output data-testid="phone-e164">{e164 ?? 'none'}</output>
        </p>
      </div>
      <PhoneInput
        label="Prefilled (GB)"
        countryLabel="Country"
        defaultCountry="GB"
        defaultValue="+442079460958"
        error="Example error"
      />
    </div>
  );
}

function DialogDemo() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Open dialog
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Transfer A012"
        description="Escape closes it. Clicking outside does not."
        footer={
          <div className="flex justify-end">
            <Button onClick={() => setOpen(false)}>Done</Button>
          </div>
        }
      >
        <Select label="Move to">
          <option>Beard trim</option>
        </Select>
      </Dialog>
    </div>
  );
}

function ChoiceDemo() {
  const [plan, setPlan] = useState('free');
  const [view, setView] = useState('list');
  const options = [
    { value: 'free', label: 'Free', hint: 'One location' },
    { value: 'team', label: 'Team', hint: 'Unlimited seats' },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Switch label="Text me when I am called" hint="Standard rates apply" />
      <Switch label="Paused" defaultChecked />
      <Switch label="Needs a phone number" error="Add a number first" />
      <RadioGroup label="Plan" options={options} value={plan} onChange={setPlan} />
      <Segmented
        label="View"
        options={[
          { value: 'list', label: 'List' },
          { value: 'timeline', label: 'Timeline' },
        ]}
        value={view}
        onChange={setView}
      />
    </div>
  );
}

function ToastDemo() {
  const toast = useToast();
  return (
    <div className="flex flex-wrap gap-3">
      <Button variant="secondary" onClick={() => toast.show({ message: 'Queue paused' })}>
        Show toast
      </Button>
      <Button
        variant="secondary"
        onClick={() => toast.show({ message: 'Could not reach the server', tone: 'danger' })}
      >
        Show error toast
      </Button>
      <Button variant="secondary" onClick={() => toast.undo('A012 marked no-show', () => {})}>
        Show undo toast
      </Button>
    </div>
  );
}
