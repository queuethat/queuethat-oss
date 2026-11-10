import { queryOptions, useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.ts';
import { ProductLine } from './BrandParts.tsx';

/** The flag for the paired device's own org: RLS lets a device read only that one row. */
export const hideProductBrandingQuery = queryOptions({
  queryKey: ['device', 'hide-product-branding'],
  staleTime: 10 * 60_000,
  queryFn: async (): Promise<boolean> => {
    const { data, error } = await supabase
      .schema('app')
      .from('organizations')
      .select('hide_product_branding')
      .limit(1)
      .single();
    if (error) throw error;
    return data.hide_product_branding;
  },
});

/**
 * The product line under a TV display or kiosk. The name waits for the org's answer (an unpaired
 * or failed read leaves the source link alone), so a hidden name never shows.
 */
export function DeviceProductLine() {
  const hidden = useQuery(hideProductBrandingQuery);
  return (
    <footer className="px-8 pb-4 opacity-80">
      <ProductLine showName={hidden.data === false} />
    </footer>
  );
}
