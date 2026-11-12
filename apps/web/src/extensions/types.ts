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
 * What a deployment adds to the web app without editing it. This repository ships none
 * (`installed.ts`); a build points `QT_WEB_EXTENSIONS` at its own module that exports
 * `extensions` with this shape. Adding a field is backwards compatible; renaming or removing one
 * is a breaking change for every deployment that builds with extensions.
 */
export interface WebExtensions {
  adminPages: ExtensionAdminPage[];
  banners: ExtensionBanner[];
}
