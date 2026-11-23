import { Button, Input } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { publicJoinUrl } from '../admin/poster/url.ts';
import { suggestSlugQuery } from './api.ts';

/**
 * What typed text becomes as a join address: lower case, anything else between letters and digits
 * as one hyphen, at most 48 characters (private.slugify's shape, so a free address comes back
 * unchanged). `done` also drops a trailing hyphen, which is left alone while typing.
 */
export function asSlug(text: string, done = false): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 48);
  return done ? slug.replace(/-+$/, '') : slug;
}

/** `value` once it has stopped changing for `ms`, so typing asks the database once, not per key. */
function useSettled(value: string, ms = 300): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export interface JoinAddress {
  /** The address the business will get: the owner's, else the suggestion; null before either. */
  address: string | null;
  /** The owner's address is in use; `suggestion` is the free one the database offers instead. */
  taken: boolean;
  suggestion: string | null;
}

/**
 * The join address for a new location (#85), asked of the database as the owner types. The
 * database owns which addresses are free; this only shows its answer.
 */
export function useJoinAddress(
  locationName: string,
  businessName: string,
  wanted: string | undefined,
): JoinAddress {
  const mine = asSlug(wanted ?? '', true);
  const [location, business, asked] = JSON.parse(
    useSettled(JSON.stringify([locationName.trim(), businessName.trim(), mine])),
  ) as [string, string, string];
  // The last answer stays on screen while the next is asked, but only a current one says "taken".
  const query = useQuery({
    ...suggestSlugQuery(location, business, asked),
    placeholderData: (last) => last,
  });
  const suggestion = location ? (query.data ?? null) : null;
  const current = asked === mine && !query.isPlaceholderData;
  return {
    address: mine || suggestion,
    taken: !!mine && current && suggestion !== null && suggestion !== mine,
    suggestion,
  };
}

/** The join address field: shows the suggestion until the owner types their own. */
export function JoinAddressField({
  join,
  wanted,
  onWanted,
}: {
  join: JoinAddress;
  wanted: string | undefined;
  onWanted: (slug: string) => void;
}) {
  const { t } = useTranslation('onboarding');
  return (
    <div className="flex flex-col gap-2">
      <Input
        label={t('location.slug')}
        hint={
          join.address
            ? t('location.slugHint', { url: publicJoinUrl(join.address) })
            : t('location.slugHintEmpty')
        }
        error={join.taken ? t('location.slugTaken', { suggestion: join.suggestion }) : undefined}
        maxLength={48}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={wanted ?? join.suggestion ?? ''}
        onChange={(event) => onWanted(asSlug(event.target.value))}
      />
      {join.taken && join.suggestion ? (
        <Button
          variant="secondary"
          className="self-start"
          onClick={() => onWanted(join.suggestion!)}
        >
          {t('location.slugUse', { suggestion: join.suggestion })}
        </Button>
      ) : null}
    </div>
  );
}
