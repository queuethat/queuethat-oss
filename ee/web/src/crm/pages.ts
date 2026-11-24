// SPDX-License-Identifier: LicenseRef-QueueThat-EE
/** Loads the `crm` namespace, then the module. Dynamic so this file stays out of every route chunk. */
export async function withCrmStrings<T>(load: () => Promise<T>): Promise<T> {
  const { loadNamespaces } = await import('@app/lib/i18n.ts');
  await loadNamespaces('admin-guests', 'crm');
  return load();
}
