# Template catalog content

One file per catalog template version: `supabase/catalog/<key>.json`. Starter waivers live in
`supabase/catalog/waivers/<key>.json`. `pnpm ci:local` lints every file with
`scripts/check-templates.ts`; the rules and the TypeScript shape (`CatalogTemplate`, `CatalogWaiver`)
are in `packages/domain/src/templates/catalog.ts`.

A content migration inserts the file into `app.template_catalog`: `key`, `version`, `tier`, `mode` and
`health_tagged` become columns, and the whole file is the `payload`. Published versions are immutable,
so an edit is a new file version and a new row.

The lint fails a template when:

- any guest- or owner-facing string is not `{"en": "...", "es": "..."}` with both filled in;
- a service has no `minutes` (1 to 480), or a prefix is not 1 to 3 capitals;
- its form asks more than 3 optional questions (headings, agreements, signatures and marketing
  consent do not count; required questions do not count);
- it is a health-class vertical (`HEALTH_CLASS_KEYS`, or `health_tagged: true`) and is not
  `health_tagged`, has a `long_text` field, has a sensitive answer that is not `short_text`, or has a
  question that does not declare its `sensitivity`;
- its form has an `agreement` (or it is a waiver) without a `waiver_banner` whose English text says
  "not legal advice".

Shape, abridged:

```json
{
  "key": "barber", "version": 2, "tier": 1, "mode": "both", "health_tagged": false,
  "name": { "en": "Barber", "es": "Barbería" },
  "description": { "en": "...", "es": "..." },
  "keywords": { "en": ["haircut", "fade"], "es": ["corte"] },
  "queues": [{ "name": {...}, "prefix": "A", "show_eta": true,
               "services": [{ "name": {...}, "minutes": 30 }] }],
  "resources": [{ "label": {...}, "kind": "chair" }],
  "providers": { "noun": { "en": "barber", "es": "barbero" }, "default_count": 3, "pool": true },
  "form": { "name": {...}, "fields": [{ "key": "style", "type": "short_text", "label": {...},
                                        "required": false, "sensitivity": "normal" }] },
  "waiver_banner": { "en": "A starting point, not legal advice. ...", "es": "..." },
  "booking": { }
}
```
