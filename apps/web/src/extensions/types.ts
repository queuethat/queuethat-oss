import type { IconDef } from '@qm/ui';
import type { Database } from '@qm/db-types';
import type { ComponentType } from 'react';

/** The admin navigation groups an extension page can join. */
export type ExtensionNavGroup = 'run' | 'team' | 'setup' | 'advanced' | 'insights' | 'account';

/**
 * A page served at `/admin/x/<path>`. The module loads only when the page opens, so extension
 * code never reaches the guest bundle.
 */
export interface ExtensionAdminPage {
  /** One URL segment: lowercase letters, digits and dashes. */
  path: string;
  /** Loads the page component. */
  load: () => Promise<{ default: ComponentType }>;
  /** Shown in the admin navigation and the "Go to…" palette when set. */
  nav?: {
    group: ExtensionNavGroup;
    icon: IconDef;
    /** i18next key with its namespace (`ns:key`). The extension registers that namespace. */
    labelKey: string;
    /** Owners and admins only. */
    adminOnly?: boolean;
    /**
     * Searchable in the "Go to…" palette but left out of the sidebar, like the app's own pages that
     * wear a section's tabs. `under` names the sidebar item that stands for it while it is open.
     */
    hidden?: boolean;
    under?: string;
  };
  /**
   * Shows the page as a tab of one of the app's tabbed sections, after the section's own tabs (or
   * before them with `first`). The page then wears that section's tab bar.
   */
  tab?: { section: ExtensionTabSection; labelKey: string; first?: boolean };
  /**
   * The roles offered the page (its nav entry and tab), for example `['owner']`. Unset: everyone
   * `nav.adminOnly` allows. It only hides links: the page itself must still handle a member who
   * opens its URL directly. (A plain list, not a hook: this module sits in every route's chunk, so
   * it must not import data code.)
   */
  roles?: string[];
}

/** The admin sections that wear a tab bar (features/admin/tabs/sectionTabs.ts). */
export type ExtensionTabSection = 'insights' | 'connections' | 'developers' | 'privacy' | 'plan';

/**
 * An old admin address that now belongs to an extension page: `/admin/<from>` (and anything under
 * it) redirects to `/admin/x/<to>`, keeping the query string. Links already sent in email or held by
 * a payment provider keep working when a deployment moves a page into its extension.
 */
export interface ExtensionRedirect {
  /** A path under /admin, without the prefix: `billing`, `settings/support`. */
  from: string;
  /** An extension page's `path`. */
  to: string;
}

export type ExtensionBannerArea = 'staff' | 'admin' | 'onboarding';

/** A banner above the staff, admin and onboarding header, for example a notice from whoever runs the install. */
export interface ExtensionBanner {
  id: string;
  /** `onboarding` is the setup flow a new business goes through before its first admin screen. */
  areas: ExtensionBannerArea[];
  load: () => Promise<{ default: ComponentType }>;
}

/**
 * The places in tenant screens where a deployment can render its own component, and the props each
 * one gets. A slot with nothing installed renders the screen's own content (or nothing).
 */
export interface ExtensionSlotProps {
  /**
   * In place of the plain message when the database refuses with `plan_limit_reached`: adding a
   * team member (`members`) or a location (`locations`). `limit` is
   * the number allowed when the database said so. For example, a deployment that sells plans can
   * explain the plan and link to its upgrade page.
   */
  'limits.reached': {
    kind: 'members' | 'locations';
    limit: number | undefined;
    role: string | undefined;
  };
  /**
   * Before a form that adds a team member (`members`) or a location (`locations`), so a deployment
   * with plan limits can say what the plan allows before the person fills anything in. Renders
   * nothing when none is installed; `limits.reached` still answers a refusal.
   */
  'limits.notice': { kind: 'members' | 'locations'; role: string | undefined };
  /**
   * In place of the error text when the database refuses to create something because the plan does
   * not include that feature (`feature_not_in_plan`) or the location has all the queues it may have
   * (`plan_limit_reached`, `feature: 'queues'`). `limit` is the number allowed, when the database
   * said so. A deployment that sells plans can explain the plan and link to its upgrade page.
   */
  'feature.gated': {
    feature: 'api' | 'integrations' | 'customRoles' | 'reports' | 'queues';
    limit: number | undefined;
  };
  /** At the top of the Integrations page, above the channel cards. */
  'integrations.top': { orgId: string; role: string };
  /** One more item in the "how guests hear from you" list on the go-live screen. */
  'onboarding.alerts': { orgId: string; role: string };
  /** The go-live screen, below that list and above the next steps. */
  'onboarding.live': { orgId: string; role: string };
  /**
   * In a visit's payments panel while the guest is called, being served or served: a form to ask
   * the guest to pay at the counter. Without it the panel offers no request.
   */
  'console.payments.request': { visitId: string };
  /**
   * Beside an unpaid counter (`pos`) payment: shows a QR the guest scans to pay it on their phone.
   * Without it the row shows only its status.
   */
  'console.payments.payCode': { visitId: string; amountMinor: number; currency: string };
  /**
   * Under one entry of the incident log (Privacy). An entry with `source` other than `manual` or
   * `reported` came from the deployment; for example it can offer a "read and confirmed" button.
   */
  'incidents.entry': { orgId: string; entry: IncidentLogEntry; canEdit: boolean };
  /**
   * In the "Report a suspected incident" form, above the submit button. `notify` is passed to
   * `api.report_incident(p_notify_platform)` (default true), which hands it to
   * `private.ext_report_incident`; a deployment that acts on it can let the business choose here.
   */
  'incidents.report': { notify: boolean; setNotify: (notify: boolean) => void };
  /**
   * In the header of the Guests page, beside the page's own buttons: a deployment that manages the
   * guest list (import, merging duplicates) links its pages here. `role` is the member's role.
   */
  'guests.actions': { role: string };
  /** On a guest's profile, between the contacts and the visit history: tags, notes. */
  'guest.profile': { guestId: string };
  /**
   * On a queue's Messages and look page, under the look: the queue's own wording for the messages
   * guests are sent. The page itself keeps the look (accent, welcome text).
   */
  'queue.templates': { queueId: string; readOnly: boolean };
  /**
   * Renders nothing. Hands `onTags` the tag names by guest id for the guests on the staff console, so
   * its rows can show them as chips. Called again whenever the guests on screen change.
   */
  'console.guestTags': { guestIds: string[]; onTags: (tags: Map<string, string[]>) => void };
}

/** An incident log row as the slot gets it. */
export type IncidentLogEntry = Database['app']['Tables']['org_incident_log']['Row'];

export type ExtensionSlotName = keyof ExtensionSlotProps;

/** Loads the component a deployment renders in a slot. */
export type ExtensionSlots = {
  [K in ExtensionSlotName]?: () => Promise<{ default: ComponentType<ExtensionSlotProps[K]> }>;
};

/**
 * What a deployment adds to the web app without editing it. This repository ships none
 * (`installed.ts`); a build points `QT_WEB_EXTENSIONS` at its own module that exports
 * `extensions` with this shape. Adding a field is backwards compatible; renaming or removing one
 * is a breaking change for every deployment that builds with extensions.
 */
export interface WebExtensions {
  // Keep the module that exports this light: the router imports it into every route's chunk, the
  // guest pages' too. Load pages, banners, slots and strings with dynamic import().
  adminPages: ExtensionAdminPage[];
  banners: ExtensionBanner[];
  /** Components for the slots in ExtensionSlotProps. */
  slots?: ExtensionSlots;
  /**
   * The deployment runs a shared sender (`provider_settings.mode` `platform`, enabled by
   * `private.deployment_settings.platform_messaging_enabled`): Integrations then lets a business
   * choose it instead of its own provider account.
   */
  sharedSender?: boolean;
  /**
   * Help articles of the deployment's own, listed after this app's on the Help page. Each id needs
   * `help.articles.<id>.title` and `.body` (a list of lines) in `admin-support`, from
   * `localeOverrides`.
   */
  helpArticles?: string[];
  /** Old admin addresses that now open an extension page. */
  redirects?: ExtensionRedirect[];
  /**
   * Strings the deployment changes or adds in this app's own namespaces, per language and namespace,
   * merged over the shipped file when that namespace loads (bundled ones: when the app starts).
   * Return undefined for none. Use it for wording, and for the strings this app looks up by key on
   * a deployment's behalf (nav and tab labels, `helpArticles`). Strings only the deployment's own
   * components read belong in its own namespaces (`ExtensionLocaleResources`), which are typed.
   */
  localeOverrides?: (lng: string, ns: string) => Promise<Record<string, unknown> | undefined>;
}

/**
 * The deployment's own translation namespaces, for typed `t()` keys. Empty here: a deployment adds
 * its namespace files under `src/locales/<lng>/` (they load like the app's own) and declares them by
 * augmenting this interface from one of its own files:
 *
 * ```ts
 * import type billing from '../locales/en/admin-billing.json';
 * declare module '../extensions/types.ts' {
 *   interface ExtensionLocaleResources { 'admin-billing': typeof billing }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled by declaration merging
export interface ExtensionLocaleResources {}
