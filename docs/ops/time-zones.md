# Time zones: two databases, one answer

Each location stores an IANA zone name (`locations.tz`, such as `America/Winnipeg`). Two
separate copies of the time zone database turn that name into a clock:

| Side          | Decides                                                                   | Its tz database                                                          |
| ------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Postgres      | What is open, the service day, booking slots, rollover (I-6, I-8)         | The one compiled into the Postgres build (or the OS's, if built that way) |
| Browser, Node | Only how a time is written on screen (`Intl.DateTimeFormat`, `formatAsOf`) | The one in the browser's ICU (Node: `process.versions.tz`)                 |

The database is the rule: the web never re-derives opening hours or the service day (rule 2). But
when the two copies disagree about a zone, every time the web writes for that zone is off by the
difference, and the database may be the stale one.

## Where each page gets its zone

- Staff and admin pages (console, Today, booking, the TV board) write times in the location's
  `tz`.
- The guest status page has no location zone in its payload, so it writes the device's own time
  and names the zone ("5:26 AM CST"), so a phone set to another zone can't be misread.

## Spotting a mismatch

Compare the two for the same zone at the same moment:

```sql
-- In the database (Supabase SQL editor, or psql)
select now() at time zone 'America/Winnipeg' as db_local, now();
```

```js
// In a browser console, or node -e
new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Winnipeg', dateStyle: 'short', timeStyle: 'short', timeZoneName: 'short',
}).format(new Date());
```

If the local times differ, the copies disagree. Check the release of each: Node prints
`process.versions.tz`; for Postgres, compare a zone whose rules changed recently against the
[IANA release notes](https://www.iana.org/time-zones).

Known case: tz release 2026e records Manitoba's move to year-round UTC-5 from March 2026. A
Postgres build with older data still uses UTC-6 for `America/Winnipeg` from November 2026. The
database corrects for this itself: every conversion goes through `private.zone(tz)`, which returns
a fixed UTC-5 zone for `America/Winnipeg` only while the database's own tz data is stale, and the
name unchanged otherwise. Times from before March 2026 would read an hour late in winter; no
install has Manitoba data that old.

## Writing SQL that converts times

Always `x at time zone private.zone(l.tz)`, never a bare `l.tz` (or `p_tz`, `v_tz`). A pgTAP guard
(`supabase/tests/hours/zone_fix.test.sql`) fails on a bare one, which also catches a function
redefined from a body copied out of a migration older than `*_manitoba_zone_fix.sql`. When another
zone's rules change before the database's data does, add it to `private.zone` in a new migration.
