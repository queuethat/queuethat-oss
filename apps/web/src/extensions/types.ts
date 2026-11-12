import type { IconDef } from '@qm/ui';
import type { ComponentType } from 'react';

/** The admin navigation groups an extension page can join. */
export type ExtensionNavGroup = 'run' | 'team' | 'setup' | 'insights' | 'account';

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
  };
}

/** A banner above the staff and admin header, for example a notice from whoever runs the install. */
export interface ExtensionBanner {
  id: string;
  areas: ('staff' | 'admin')[];
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
  /** At the top of the Integrations page, above the channel cards. */
  'integrations.top': { orgId: string; role: string };
  /** One more item in the "how guests hear from you" list on the go-live screen. */
  'onboarding.alerts': { orgId: string; role: string };
  /** The go-live screen, below that list and above the next steps. */
  'onboarding.live': { orgId: string; role: string };
}

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
}
