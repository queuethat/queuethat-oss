import { createFileRoute } from '@tanstack/react-router';
import { DeviceGate } from '../features/device/DeviceGate.tsx';
import { CounterDisplay } from '../features/display/counter/CounterDisplay.tsx';
import { loadNamespaces } from '../lib/i18n.ts';
import { DisplayLayout } from '../layouts/DisplayLayout.tsx';

// `/display/counter` is bookmarked on paired counter screens. Never rename or move it. The
// `display_` segment keeps it a sibling of `/display`, which is not a layout.
export const Route = createFileRoute('/display_/counter')({
  beforeLoad: () => loadNamespaces('guest'),
  component: CounterPage,
});

function CounterPage() {
  return (
    <DisplayLayout kind="display">
      <DeviceGate kind="display">
        <CounterDisplay />
      </DeviceGate>
    </DisplayLayout>
  );
}
