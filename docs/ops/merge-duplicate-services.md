# Merging duplicate services (location-level services)

Before location-level services (#75), every queue stored its own copy of each service, so a
location with four chairs could hold "Haircut" four times. A service now belongs to the location and
queues offer it through `app.queue_services`. New locations never create copies. Existing
locations keep theirs until an operator merges them. Nothing runs automatically: the migration only
installs two functions, because the merge changes data.

Run both as the `postgres` role (they live in `private` and are not callable through the API).

## 1. Dry run (no writes)

```sql
select * from private.service_merge_plan();            -- every location
select * from private.service_merge_plan('<location uuid>');
```

One row per group of same-named services at a location:

| column                    | meaning                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `outcome = 'merge'`       | `copies` services are identical (name, minutes, ticket prefix, colour, description, journey, booking and payment settings)     |
| `outcome = 'keep'`        | a service that differs from its namesakes; stays separate                                                                      |
| `flagged`, `detail`       | the name exists in more than one variant; `detail` lists what differs. The owner sees a notice on the Services page             |
| `service_ids`             | oldest first; the first is the survivor                                                                                        |

Only names that repeat appear. An empty result means there is nothing to do.

## 2. Merge

```sql
select private.merge_identical_services();             -- every location
select private.merge_identical_services('<location uuid>');
```

Returns the number of groups merged. For each group, the oldest copy survives. The others become
inactive with `merged_into_id` pointing at the survivor.

Moves to the survivor: queue links, availability and capacity rules, resources, form targets, the
slot waitlist, routing rules and journey steps. The survivor's booking and payment policy stay (they
were identical). Capacity already used under a copy is added to the survivor's counts; if one of those
appointments is later cancelled, the survivor stays counted until that date passes, so a slot can
look full a little longer. The survivor's learned durations are reset and relearn from all visits.

Never rewritten (invariant I-1): visits, appointments, events and series. They keep pointing at the
retired copy, which still exists, so history and reports stay readable.

## Undoing

Set `active = true, merged_into_id = null` on a retired copy and add its `queue_services` rows back.
Nothing is deleted, but moved rules are not split again.
