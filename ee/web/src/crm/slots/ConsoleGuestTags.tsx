// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import { useEffect } from 'react';
import { useGuestTagMap } from '../tags/api.ts';

/** Slot `console.guestTags`: reads the tags of the guests on the console and hands them up. */
export default function ConsoleGuestTags({
  guestIds,
  onTags,
}: {
  guestIds: string[];
  onTags: (tags: Map<string, string[]>) => void;
}) {
  const tags = useGuestTagMap(guestIds).data;
  useEffect(() => {
    if (tags) onTags(tags);
  }, [tags, onTags]);
  return null;
}
