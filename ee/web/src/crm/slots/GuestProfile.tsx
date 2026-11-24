// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import { GuestNotes } from '../notes/GuestNotes.tsx';
import { GuestTags } from '../tags/GuestTags.tsx';

/** Slot `guest.profile`: tags and notes on a guest's profile. */
export default function GuestProfile({ guestId }: { guestId: string }) {
  return (
    <>
      <GuestTags guestId={guestId} />
      <GuestNotes guestId={guestId} />
    </>
  );
}
