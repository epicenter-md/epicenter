# Whispering App

Browser-hostable Svelte 5 speech-to-text SPA. Epicenter owns its only native Tauri runtime.

## Key Points

- Three-layer architecture: Service -> Query -> UI
- Services are pure functions returning `Result<T, E>`
- Build-time platform seams use `#platform/*` imports: `epicenter-host` when the Bun host owns the thing (credential, deployment choice, asset base), `tauri` when the leaf calls a native command (ADR-0190). The replica is NOT one of those things any more: ADR-0226 refused a host-owned data plane, so every build opens its own store and a storage seam is the thing to delete rather than to route. Whispering has no build where `epicenter-host` and `tauri` come apart, so the whole seam collapses to one leaf when it is rebuilt.
- Tauri-only capabilities live in `$lib/tauri.tauri.ts`; shared consumers go through `#platform/*`.
- Query layer handles reactivity, caching, and error transformation
- See `ARCHITECTURE.md` for detailed patterns

## Don'ts

- Don't put business logic in Svelte components
- Don't access settings directly in services (pass as parameters)
- Don't use try-catch; use wellcrafted Result types

## Tauri Commands

Load `tauri` before adding or changing Tauri commands, permissions,
capabilities, generated bindings, or platform filesystem behavior. Load
`rust-errors` when a command changes Rust error payloads consumed by
TypeScript.

Every command change must keep `make_specta_builder()` in
`../epicenter/src-tauri/src/lib.rs`, generated bindings, and
`src/lib/tauri/commands.ts` in sync. The command boundary file is the only place
in `src/lib/**` that may import `invoke` from `@tauri-apps/api/core` for app
commands.

## Specs and Docs

- App-specific specs: `./specs/`
- App-specific docs: `./docs/` (if needed)
- Cross-cutting specs: `/specs/`
- Cross-cutting docs: `/docs/`

See root `AGENTS.md` for the full organization guide.
