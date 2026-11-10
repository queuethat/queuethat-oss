# Google Business Profile join link

Google's "join waitlist" button on Maps needs partner approval, so it is not available to a
self-hosted install. What works for free: put your join link in the **Booking links** (or
**Appointment link**) field of your Business Profile.

1. Admin, **Google listing**: copy the link. It is your join page with `?src=gbp` added
   (`https://<your site>/q/<slug>?src=gbp`).
2. Google Business Profile, **Edit profile, Booking links**: paste it and save.
3. Open the link on a phone to check it.

## Attribution

The join page sends the `src` value to the `public-join` function, which keeps it only when it is one
of `gbp`, `widget` or `poster`; any other text is dropped and nothing from it is stored. The value
lands in `visits.attribution` (not `visits.source`: that column is the channel the join rules key on,
such as the on-site code and geofence checks, and must not carry guest-influenced values). The embeddable
widget sets `widget` itself. There is no report on it yet, so query `visits.attribution` directly.
