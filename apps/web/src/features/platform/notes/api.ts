import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

// #1135: internal support notes and tags per tenant. One hook per RPC; the database decides who
// may call them (support and operators with aal2), who may edit a note, and which tags are valid.

/** `api.platform_org_note`: one note at one version. */
export interface OrgNote {
  /** The note's stable id; pass it back to edit the note. */
  id: string;
  version_id: string;
  org_id: string;
  author_email: string | null;
  body: string;
  tags: string[];
  version: number;
  /** When this version was written. */
  created_at: string;
  /** When the note was first written. */
  first_created_at: string;
}

/** `api.platform_tagged_org`: a tenant that has tagged notes. */
export interface TaggedOrg {
  org_id: string;
  org_name: string;
  tags: string[];
  /** Decided by the database (churn-risk, billing-issue). */
  needs_attention: boolean;
  notes: number;
  last_note_at: string | null;
}

/** Tags the form offers as suggestions; the database accepts any valid tag. */
export const SUGGESTED_TAGS = ['pilot', 'vip', 'churn-risk', 'billing-issue'] as const;

/** Splits "vip, churn-risk  pilot" into raw tags; the database lower-cases and de-duplicates. */
export function parseTags(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

/** A tenant's current notes (`api.platform_list_notes`), or every version with `history`. */
export const notesQuery = (orgId: string, history: boolean) =>
  queryOptions({
    queryKey: ['platform', 'notes', orgId, history],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('platform_list_notes', {
        p_org_id: orgId,
        p_include_history: history,
      });
      if (error) throw new Error(errorCode(error));
      return data as unknown as OrgNote[];
    },
  });

/** Tenants with tagged notes (`api.platform_tagged_orgs`), optionally only those with `tag`. */
export const taggedOrgsQuery = (tag?: string) =>
  queryOptions({
    queryKey: ['platform', 'tagged', tag ?? null],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        'platform_tagged_orgs',
        tag ? { p_tags: [tag] } : {},
      );
      if (error) throw new Error(errorCode(error));
      return data as unknown as TaggedOrg[];
    },
  });

export interface NoteInput {
  orgId: string;
  body: string;
  tags: string[];
  /** Set to write the next version of that note. */
  noteId?: string | undefined;
  /** Reused for retries of one submit, so a double click stores one note. */
  idempotencyKey: string;
}

/** Adds a note, or edits one when `noteId` is set (`api.platform_add_note`). */
export function useAddNote() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: NoteInput) => {
      const { data, error } = await supabase.rpc('platform_add_note', {
        p_org_id: input.orgId,
        p_body: input.body,
        p_tags: input.tags,
        p_idempotency_key: input.idempotencyKey,
        ...(input.noteId ? { p_note_id: input.noteId } : {}),
      });
      if (error) throw new Error(errorCode(error));
      return data as unknown as OrgNote;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['platform'] }),
  });
}
