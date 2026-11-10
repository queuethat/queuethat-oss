# Unsubscribe link secrets

Set these as Edge Function secrets (`supabase secrets set`). Names can't start with `SUPABASE_`.

| Secret                        | Used by                        | Notes                                                              |
| ----------------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `UNSUBSCRIBE_SECRET`          | dispatch-notifications, unsubscribe | 32+ characters. Unset: guest email goes out with no stop link. |
| `UNSUBSCRIBE_SECRET_PREVIOUS` | unsubscribe                    | The old secret during a rotation.                                  |
| `PUBLIC_SITE_URL`             | dispatch-notifications         | Hosts the `/u` confirm page.                                       |
| `PUBLIC_FUNCTIONS_URL`        | dispatch-notifications         | Optional https gateway for List-Unsubscribe; defaults to `SUPABASE_URL`. Not https: no header. |

**Rotation.** Move the current value to `UNSUBSCRIBE_SECRET_PREVIOUS`, set a new `UNSUBSCRIBE_SECRET`,
and **remove `UNSUBSCRIBE_SECRET_PREVIOUS` after 30 days** (CAN-SPAM's honour window). Until it is
removed, every link signed with it keeps working.
