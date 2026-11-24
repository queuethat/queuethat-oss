// SPDX-License-Identifier: LicenseRef-QueueThat-EE
// Copyright (c) QueueThat. Licensed under the QueueThat Commercial License (ee/LICENSE).

/**
 * The name a custom domain's CNAME should point at. `configured` is `VITE_DOMAIN_CNAME`, for a
 * deployment whose TLS layer wants its own target; otherwise the host of the public URL (or of the
 * page when there is none), which is where a self-hosted install's Caddy answers.
 */
export function dnsTargetFor(
  configured: string | undefined,
  publicUrl: string,
  origin: string,
): string {
  const own = (configured ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/.]+$/, '');
  if (own) return own;
  try {
    return new URL(publicUrl || origin).hostname;
  } catch {
    return new URL(origin).hostname;
  }
}
