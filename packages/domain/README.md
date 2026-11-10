# @qm/domain

Pure TypeScript shared by the web app and Edge Functions: phone normalisation, ETA label formatting, ticket display, error-code map.

**Rules**

- No runtime dependencies. This package must stay plain ESM that Deno can import directly, so Edge Functions can use it.
- Relative imports use explicit `.ts` extensions (Deno requires them).
- No business rules that the database owns (state machine, ETA degradation). This package formats decisions the database returns; see `docs/architecture/technical-design.md` section 3.5.
