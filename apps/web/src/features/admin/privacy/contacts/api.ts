import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../../lib/supabase.ts';

export const JURISDICTIONS = [
  'ca',
  'ca_ab',
  'ca_bc',
  'ca_qc',
  'us',
  'eu',
  'uk',
  'au',
  'other',
] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];
export type ReportingLinkKey =
  'opc' | 'oipcAb' | 'oipcBc' | 'cai' | 'ftc' | 'edpb' | 'ico' | 'oaic';

/** Regulator pages shown beside the jurisdiction picker. Information only; the app never files anything. */
export const REPORTING_LINKS: Record<
  Jurisdiction,
  readonly { key: ReportingLinkKey; href: string }[]
> = {
  ca: [
    {
      key: 'opc',
      href: 'https://www.priv.gc.ca/en/privacy-topics/business-privacy/safeguards-and-breaches/privacy-breaches/respond-to-a-privacy-breach-at-your-business/',
    },
  ],
  ca_ab: [{ key: 'oipcAb', href: 'https://oipc.ab.ca/' }],
  ca_bc: [{ key: 'oipcBc', href: 'https://www.oipc.bc.ca/' }],
  ca_qc: [{ key: 'cai', href: 'https://www.cai.gouv.qc.ca/' }],
  us: [
    {
      key: 'ftc',
      href: 'https://www.ftc.gov/business-guidance/resources/data-breach-response-guide-business',
    },
  ],
  eu: [{ key: 'edpb', href: 'https://www.edpb.europa.eu/about-edpb/about-edpb/members_en' }],
  uk: [{ key: 'ico', href: 'https://ico.org.uk/for-organisations/report-a-breach/' }],
  au: [{ key: 'oaic', href: 'https://www.oaic.gov.au/privacy/notifiable-data-breaches' }],
  other: [],
};

export interface PrivacyContact {
  officerName: string;
  email: string;
  phone: string;
  jurisdiction: Jurisdiction;
  showPhone: boolean;
}

const contactKey = (orgId: string) => ['admin', 'privacy', orgId, 'contact'] as const;

/** The recorded privacy officer, or null when none is. RLS shows it to managers, admins and owners. */
export const privacyContactQuery = (orgId: string) =>
  queryOptions({
    queryKey: contactKey(orgId),
    queryFn: async (): Promise<PrivacyContact | null> => {
      const { data, error } = await supabase
        .schema('app')
        .from('org_privacy')
        .select('officer_name, email, phone, jurisdiction, notice_prefs')
        .eq('org_id', orgId)
        .maybeSingle();
      if (error) throw new Error(errorCode(error));
      if (!data) return null;
      const prefs = data.notice_prefs as { show_phone?: boolean } | null;
      return {
        officerName: data.officer_name,
        email: data.email,
        phone: data.phone ?? '',
        jurisdiction: data.jurisdiction as Jurisdiction,
        showPhone: prefs?.show_phone === true,
      };
    },
  });

/**
 * Records or updates the privacy officer. Admins and owners only (RLS); the database validates
 * every field. Sensitive form fields and SMS stay blocked until one is recorded.
 */
export function useSavePrivacyContact(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (c: PrivacyContact) => {
      const { data, error } = await supabase
        .schema('app')
        .from('org_privacy')
        .upsert({
          org_id: orgId,
          officer_name: c.officerName.trim(),
          email: c.email.trim(),
          phone: c.phone.trim() || null,
          jurisdiction: c.jurisdiction,
          notice_prefs: { show_phone: c.showPhone },
        })
        .select('org_id');
      if (error) throw new Error(errorCode(error));
      // RLS hides rows the caller may not change instead of failing.
      if (data.length === 0) throw new Error('permission_denied');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: contactKey(orgId) }),
  });
}
