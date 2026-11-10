import { createFileRoute } from '@tanstack/react-router';
import { DeviceGate } from '../features/device/DeviceGate.tsx';
import { KioskApp } from '../features/kiosk/KioskApp.tsx';
import { loadNamespaces } from '../lib/i18n.ts';
import { DisplayLayout } from '../layouts/DisplayLayout.tsx';

// `/kiosk` is bookmarked on paired kiosks. Never rename or move it.
export const Route = createFileRoute('/kiosk')({
  beforeLoad: () => loadNamespaces('kiosk', 'guest'),
  component: KioskPage,
});

function KioskPage() {
  return (
    <DisplayLayout kind="kiosk">
      <DeviceGate kind="kiosk">
        <KioskApp />
      </DeviceGate>
    </DisplayLayout>
  );
}
