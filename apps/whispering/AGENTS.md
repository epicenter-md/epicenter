# Whispering App

Svelte 5 speech-to-text SPA served by the Epicenter desktop host, which owns its only native Tauri runtime. `bun dev:whispering` runs the same SPA in a browser tab for development.

## Key Points

- Three-layer architecture: Service -> Query -> UI
- Services are pure functions returning `Result<T, E>`
- Build-time platform seams use `#platform/*` imports, and Whispering has three: `auth`, `binding`, and `blobs`, each with an `epicenter-host` leaf (the Bun host brokers the credential, holds the keychain and files, streams recording bytes) and a `default` leaf for `bun dev:whispering` in a browser tab (ADR-0347). Every other `#platform/*` entry is a plain path alias to one module; the `tauri` condition selects nothing here and no seam may name it. The store is never a seam: every build opens its own (ADR-0226). Base path is not one either; use `resolve` from `$app/paths`. `src/lib/platform-selection.test.ts` reads the declarations.
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
