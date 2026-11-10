import account from './account.json';
import admin from './admin.json';
import adminNav from './admin-nav.json';
import adminSupport from './admin-support.json';
import adminApiKeys from './admin-api-keys.json';
import adminDomains from './admin-domains.json';
import adminReports from './admin-reports.json';
import adminIntegrations from './admin-integrations.json';
import adminWhatsapp from './admin-whatsapp.json';
import adminChatAlerts from './admin-chat-alerts.json';
import adminWebhooks from './admin-webhooks.json';
import announce from './announce.json';
import adminForms from './admin-forms.json';
import adminGuests from './admin-guests.json';
import adminHours from './admin-hours.json';
import adminPrivacy from './admin-privacy.json';
import adminUsage from './admin-usage.json';
import adminBilling from './admin-billing.json';
import appointments from './appointments.json';
import shifts from './shifts.json';
import adminRoles from './admin-roles.json';
import adminSetup from './admin-setup.json';
import adminTeam from './admin-team.json';
import adminTemplates from './admin-templates.json';
import adminFormBuilder from './admin-form-builder.json';
import adminJourneys from './admin-journeys.json';
import payments from './payments.json';
import auth from './auth.json';
import booking from './booking.json';
import common from './common.json';
import consoleHints from './console-hints.json';
import crm from './crm.json';
import devInbox from './dev-inbox.json';
import display from './display.json';
import empty from './empty.json';
import eta from './eta.ts';
import guest from './guest.json';
import guestChat from './guest-chat.json';
import guestFeedback from './guest-feedback.json';
import guestInfo from './guest-info.json';
import guestIntake from './guest-intake.json';
import guestJoin from './guest-join.json';
import guestParty from './guest-party.json';
import guestSnooze from './guest-snooze.json';
import guestStatus from './guest-status.json';
import kiosk from './kiosk.json';
import marketing from './marketing.json';
import onboarding from './onboarding.json';
import staff from './staff.json';

/**
 * English strings, one namespace per area. A new area adds its JSON file here. Used for key
 * types only: lib/i18n.ts bundles the guest namespaces and loads the rest on demand.
 */
export const en = {
  common,
  crm,
  'console-hints': consoleHints,
  'guest-info': guestInfo,
  // Typed as one namespace: the join and status strings load with their routes and are found
  // through `fallbackNS` (lib/i18n.ts), so every guest component keeps writing t('join.title').
  guest: { ...guest, ...guestJoin, ...guestStatus },
  'guest-chat': guestChat,
  'guest-feedback': guestFeedback,
  'guest-intake': guestIntake,
  'guest-join': guestJoin,
  'guest-party': guestParty,
  'guest-snooze': guestSnooze,
  'guest-status': guestStatus,
  staff,
  account,
  admin,
  'admin-nav': adminNav,
  'admin-support': adminSupport,
  'admin-api-keys': adminApiKeys,
  'admin-chat-alerts': adminChatAlerts,
  'admin-domains': adminDomains,
  'admin-reports': adminReports,
  'admin-integrations': adminIntegrations,
  'admin-whatsapp': adminWhatsapp,
  'admin-webhooks': adminWebhooks,
  'admin-forms': adminForms,
  'admin-guests': adminGuests,
  'admin-hours': adminHours,
  'admin-privacy': adminPrivacy,
  'admin-usage': adminUsage,
  'admin-billing': adminBilling,
  appointments,
  'admin-roles': adminRoles,
  'admin-setup': adminSetup,
  'admin-team': adminTeam,
  shifts,
  'admin-templates': adminTemplates,
  'admin-form-builder': adminFormBuilder,
  'admin-journeys': adminJourneys,
  payments,
  auth,
  booking,
  'dev-inbox': devInbox,
  announce,
  display,
  empty,
  kiosk,
  marketing,
  onboarding,
  eta,
};

export type Namespace = keyof typeof en;
