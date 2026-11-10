import { createFileRoute } from '@tanstack/react-router';
import { DeviceGate } from '../features/device/DeviceGate.tsx';
import { DisplayBoard } from '../features/display/DisplayBoard.tsx';
import { loadNamespaces } from '../lib/i18n.ts';
import { DisplayLayout } from '../layouts/DisplayLayout.tsx';

// `/display` is bookmarked on paired TVs. Never rename or move it.
export const Route = createFileRoute('/display')({
  beforeLoad: () => loadNamespaces('guest'),
  component: DisplayPage,
});

function DisplayPage() {
  return (
    <DisplayLayout kind="display">
      <DeviceGate kind="display">
        <DisplayBoard />
      </DeviceGate>
    </DisplayLayout>
  );
}
