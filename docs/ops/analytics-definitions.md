# Analytics definitions

One definition per figure, owned by the database (`api.history_stats`, `api.outcome_rates`). The admin
analytics page renders these values and never recomputes them.

| Figure | Definition |
| --- | --- |
| Joined | Visits whose service day (day buckets) or local joining hour (hour buckets) falls in the bucket. |
| Wait | `called_at - joined_at`, only for visits that were called. avg, p50 and p90 are over those visits. |
| Service time | `finished_at - serving_at`, only for visits that were served. |
| Left waiting | Visits that are no longer waiting, excluding expired ones: served, no_show, cancelled, removed, called, serving. |
| Abandonment rate | `cancelled / left_waiting`. Cancelled means the guest left; staff removal (`removed`) and rollover expiry (`expired`) are separate outcomes. |
| Abandonment by wait band | Cancelled visits split by time waited before leaving: under 10, 10 to 30, over 30 minutes. |
| No-show rate | `no_show / called`, where called means `called_at` is set. |

Buckets are local to the location. A DST change day has 23 or 25 hours; the repeated hour is one bucket.
Rates are `numeric(5,4)` (0.2000 is 20%) and null when the denominator is 0. Empty buckets are omitted.
Only timestamps, status, queue and service are read, so retention anonymization never changes a result.
