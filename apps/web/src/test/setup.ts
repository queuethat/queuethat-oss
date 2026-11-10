import '../../../../packages/ui/src/test/setup.ts';
import { loadNamespaces } from '../lib/i18n.ts';

// The join and status strings load with their routes; tests render those pages directly.
await loadNamespaces('guest-join', 'guest-status');

// jsdom lacks scrollTo, which the router's scroll restoration calls.
window.scrollTo = () => {};
