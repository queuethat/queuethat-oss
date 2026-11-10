# Realtime pulse load test (K1, #28)

Measures the guest live-update path from technical-design.md 3.4: a staff action writes an event,
a trigger calls `realtime.send` to `loc:{location_id}` and `qpulse:{pulse_id}`, and every guest on
the pulse refetches its own status 0-1.5 s later. Results and the decision are in
[docs/ops/realtime-spike.md](../../docs/ops/realtime-spike.md).

## Files

- `setup.sql` installs a stand-in fixture in a `loadtest` schema plus two RPCs,
  `api.loadtest_call_next` (service role) and `api.loadtest_visit_status` (anon). It is not a
  migration and must never reach a shared database. `teardown.sql` removes it; so does
  `pnpm db:reset`.
- `pulse.js` is the k6 script: `GUESTS` sockets join the pulse over `RAMP_S` seconds, one staff VU
  calls next every 10-30 s for `WINDOW_S` seconds, and each guest refetches after random jitter.
- `run.sh` sets the realtime tenant and Kong limits, pins the Supabase containers to two CPUs,
  seeds, runs each guest count and writes `results/<mode>/guests-<n>.json` (summary, committed),
  `.stats.txt` (peak CPU and last memory per container, committed) and `.log` (k6 warnings,
  ignored).

## Run

Needs Docker, the local stack (`pnpm db:start`) and [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) 1.x.

```sh
bash deploy/load/run.sh default 100 250 500   # CLI-shipped tenant limits (= Cloud free plan)
bash deploy/load/run.sh tuned 100 250 500 1000 # limits raised, as on a self-host box
```

A level takes about five minutes. `run.sh` leaves the containers pinned to CPUs 0-1 and the tenant
and Kong limits changed; `pnpm db:stop && pnpm db:start` puts them back. It needs a stack started
by the CLI (container names `supabase_*_queue-management`) and four or more CPUs.

## Metrics

| Metric                | Meaning                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pulse_delivery_ms`   | event insert (DB clock) to the pulse arriving on the guest socket                                               |
| `refetch_ms`          | the `loadtest_visit_status` RPC round trip alone                                                                |
| `event_to_refetch_ms` | event insert to the guest holding fresh status; includes the 0-1.5 s jitter, so ~1.4 s of any p95 is deliberate |
| `drop_rate`           | 1 - pulses received / (pulses sent x guests whose join succeeded)                                               |
| `joins_failed`        | joins the server refused, for example `too_many_connections`                                                    |

The DB, Realtime and k6 share a host clock, so the cross-process timings are valid locally only.
