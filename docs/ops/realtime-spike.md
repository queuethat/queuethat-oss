# Realtime spike: pulse fan-out at 100/250/500 guests (K1, #28)

**Decision: go.** Pulse plus jittered refetch meets the target at 500 guests on a 2 vCPU stack:
p95 event-to-refetch **1.46 s** (< 2 s), **0 dropped pulses**. Two default limits get in the way
first, and the design has to plan around both:

1. **200 sockets.** Supabase Cloud Free allows 200 concurrent Realtime connections, and the local
   CLI ships the same tenant limit. The 201st guest's handshake is refused (HTTP 429). That guest
   gets no pulses at all, only the 30 s poll.
2. **Kong's 512 worker connections** (self-host). The CLI's gateway runs one nginx worker with 512
   connections, and each proxied socket uses two of them. At about 250 sockets the gateway runs out:
   new handshakes fail, **and so do REST calls**. Staff `call_next` returned 500 in that run, so
   realtime load took down the staff API. A self-host box must raise
   `KONG_NGINX_EVENTS_WORKER_CONNECTIONS`, or put a gateway in front that is sized for sockets.

With both raised, 500 guests pass comfortably and 1000 guests miss the target (p95 2.4 s), because
PostgREST saturates the two cores during the refetch burst.

Harness and raw outputs: [deploy/load/](../../deploy/load/README.md). V9 (#38) uses this pattern.

## Setup

- Local Supabase CLI stack (`pnpm db:start`, Supabase CLI 2.122.0, Kong 2.8.1). Every container is
  pinned to two CPUs (`docker update --cpuset-cpus 0,1`) to approximate a 2 vCPU box. k6 1.3.0 runs
  on the other cores.
- Stand-in fixture (`deploy/load/setup.sql`, not a migration). An AFTER INSERT trigger on an event
  table calls `realtime.send` twice, to `loc:{location_id}` and to `qpulse:{pulse_id}` (design 3.4).
  The guest refetch is a definer RPC that looks up sha256(token) and counts the visit's position,
  which is the expensive part of `get_visit_status`.
- Each level: N guests join the pulse over 30 s. After 15 s, one staff VU calls next every
  10–30 s for 240 s (11–13 pulses). Each guest refetches after a random 0–1.5 s jitter.
- "default" = the limits the CLI ships: tenant 200 users, 100 events/s, 100 joins/s, and Kong 512
  worker connections. "tuned" = tenant 10,000 / 10,000 / 1,000 and Kong 8,192.

## Results

Latencies are p95 in ms. Delivery is commit to socket. Refetch is the RPC round trip alone.
Event-to-refetch is commit to the guest holding fresh status, and includes the deliberate 0–1.5 s
jitter (about 1.4 s of every p95 below). Drop rate is 1 − received ÷ (sent × connected guests).

| Mode | Guests | Connected | Refused | Pulses | Drop rate | Delivery p95 | Refetch p95 | Event-to-refetch p95 |
|---|---|---|---|---|---|---|---|---|
| default | 100 | 100 | 0 | 12 | 0 | 17 | 4 | 1,448 |
| default | 250 | 200 | 50 | 13 | 0 | 20 | 6 | 1,443 |
| default | 500 | 200 | 300 | 11 | 0 | 21 | 5 | 1,436 |
| tuned | 100 | 100 | 0 | 12 | 0 | 20 | 4 | 1,452 |
| tuned | 250 | 250 | 0 | 11 | 0 | 23 | 6 | 1,437 |
| tuned | 500 | 500 | 0 | 14 | 0 | 41 | 7 | 1,458 |
| tuned | 1000 | 1000 | 0 | 12 | 0 | 80 | 1,413 | 2,396 |

Across all runs there were zero stale reads (no refetch returned an older version than its pulse)
and zero refetch errors. The first tuned runs at 100 and 500 had one unseeded guest, a harness bug
that is now fixed, and those two levels were re-run; the rows above are the re-runs. The 250 and
1000 logs also show harmless heartbeat-after-close warnings from the same old harness version.

In "default" mode, refused guests count as "refused", not as drops. From their point of view,
though, they have no live updates: at 500 guests on default limits, 60% of guests are on 30 s
polling only.

Peak container CPU at 1000 guests (two cores = 200%): PostgREST 133%, Postgres 59%, Kong 27%,
Realtime 20%. Realtime itself is cheap: 0.3 GB and 20% CPU holding 1000 sockets. Total stack memory
stayed under 2 GB, and that includes Studio, Logflare and Vector, which a production box wouldn't
run. So 4 GB is enough.

## What a local run can and can't tell us about Supabase Cloud Free

It **can** tell us:
- The application side holds up: trigger cost, refetch query cost, jitter spreading, and version
  ordering. These run the same code in both places.
- The connection cap behaves the same way. The CLI ships the Free plan's 200-user tenant limit,
  and both refuse the 201st socket instead of degrading.

It **can't** tell us:
- **Cloud latency.** Here everything shares one host and one clock, with no network. Cloud adds
  client-to-region RTT on both the socket and the refetch (tens to hundreds of ms on mobile). Cloud
  Realtime is a multi-node cluster, so delivery may differ.
- **The messages-per-second limit.** Free allows 100 messages/s, counting "a WebSocket message
  delivered to, or sent from a client"
  ([limits](https://supabase.com/docs/guides/realtime/limits)). One pulse to 200 guests is 201
  messages at once. Locally, a 100 events/s tenant limit never disconnected anyone, so the local
  server evidently doesn't count fan-out the same way, or averages over a longer window. Cloud
  disconnects clients when a project goes over. **This is unverified and needs a Cloud test before
  the pilot.**
- **Monthly quota.** Free includes 2M messages/month, and a broadcast to N listeners counts N + 1
  ([billing](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages)). With
  V9's two sends per change, one change costs about 2 + guests + staff screens. A location with 30
  people waiting on average, 300 visits a day and about 4 changes per visit uses roughly 1.3M
  messages/month. **Free covers one busy location, not several.** Pro includes 5M, then $2.50 per
  million.
- The cost of RLS on private channels. This spike used a public pulse channel. V9 (#452) then made
  both topics private, because on a public channel any subscriber can broadcast forged pulses to
  the others (reproduced locally). Realtime checks the
  policy on join, not per message, so this run's public-channel numbers should hold. I didn't
  measure it.

## Consequences for the build

- V9 (#38): keep pulse plus refetch. Send once per queue per transaction, so a burst of changes is
  one pulse.
- L1 (#40): treat a refused join (`too_many_connections`, HTTP 429) as "poll only", with backoff,
  not a reconnect loop. Keep the 30 s poll; past 200 guests on Free it is the only update path.
  Keep the 0–1.5 s jitter for now. If one queue ever holds 1000+ live guests, widen it with N,
  because the refetch burst, not Realtime, is the bottleneck.
- Self-host docs (D-series): set `KONG_NGINX_EVENTS_WORKER_CONNECTIONS` (8192 worked here) and raise
  the Realtime tenant limits. Otherwise realtime load starves the REST API through the shared
  gateway.
- Pilot on Cloud Free: fine for one location up to 200 concurrent live guests. Before onboarding a
  second busy location, plan Pro, or reduce message volume (for example, staff screens subscribe
  only to `loc:`).

## Reproduce

```sh
pnpm db:start
bash deploy/load/run.sh default 100 250 500
bash deploy/load/run.sh tuned 100 250 500 1000
```
