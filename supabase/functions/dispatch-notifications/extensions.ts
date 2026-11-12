// What a deployment adds to the dispatcher without editing it. This repository adds nothing; a
// deployment that runs a shared sender (provider_settings.mode `platform`, see
// private.deployment_settings.platform_messaging_enabled) ships its own copy of this file.
// Keep the export's name and shape: changing them breaks every such deployment.
import type { SharedSender } from './factories.ts';

/**
 * The shared sender for orgs in mode `platform`, built from the deployment's environment, or
 * undefined when it has none (such sends then end as `suppressed: channel_disabled`).
 * `functionsUrl` is PUBLIC_FUNCTIONS_URL, for delivery-report routes (provider-webhook/extensions.ts).
 */
export function sharedSender(_deps: {
  env(name: string): string | undefined;
  functionsUrl: string;
}): SharedSender | undefined {
  return undefined;
}
