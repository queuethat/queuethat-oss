import { errorCode } from '@qm/domain';
import { useMutation, useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.ts';
import { membersQuery } from '../admin/team/api.ts';
import { clearOperator, getOperatorToken, setOperator } from './session.ts';

/**
 * Colleagues who can be switched to: members with a PIN who work at this location. The database
 * checks the same thing again; a PIN that doesn't match all look alike (`api.switch_operator`).
 */
export function useSwitchCandidates(orgId: string, locationId: string) {
  return useQuery({
    ...membersQuery(orgId),
    select: (members) =>
      members.filter(
        (m) =>
          m.userId && m.hasPin && (m.locationIds === null || m.locationIds.includes(locationId)),
      ),
  });
}

/** `api.switch_operator`. Resolves false for a wrong PIN, an unknown member or a lockout. */
export function useSwitchOperator(locationId: string) {
  return useMutation({
    mutationFn: async ({ userId, pin }: { userId: string; pin: string }) => {
      const { data, error } = await supabase.rpc('switch_operator', {
        p_location_id: locationId,
        p_user_id: userId,
        p_pin: pin,
      });
      if (error) throw new Error(errorCode(error));
      if (!data.operator_token) return false;
      setOperator({
        token: data.operator_token,
        userId: data.user_id!,
        displayName: data.display_name,
        role: data.role!,
        expiresAt: data.expires_at!,
      });
      return true;
    },
  });
}

/** Ends the operator session on the server, then forgets the token. Locking never fails visibly. */
export async function lockOperator() {
  const token = getOperatorToken();
  clearOperator();
  if (token) await supabase.rpc('end_operator_session', { p_operator_token: token });
}

/** `api.set_my_pin`. Errors: `invalid_input` (4 to 8 digits, no runs), `permission_denied` (under an operator). */
export function useSetMyPin(orgId: string) {
  return useMutation({
    mutationFn: async (pin: string) => {
      const { error } = await supabase.rpc('set_my_pin', { p_org_id: orgId, p_pin: pin });
      if (error) throw new Error(errorCode(error));
    },
  });
}
