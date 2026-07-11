# Epicenter desktop host

Epicenter is the repository's native application host. It owns one Tauri runtime, one native command surface, and the trusted app catalog. Product SPAs keep their source in their own `apps/*` folders; Epicenter builds and serves their desktop variants without copying that source into this folder.

```text
trusted SPA source                 Epicenter build output

apps/whispering/src  -----------> dist/whispering
apps/epicenter/ui     -----------> dist/query
                                          |
                                          v
                              Bun loopback sidecar
                                          |
                                          v
                              apps/epicenter/src-tauri
```

Whispering is the first full product surface under this model. Its browser build remains independently deployable; its `tauri` build condition activates native implementations and uses `/apps/whispering` as its asset base.

## Run locally

Start Epicenter from the repository root:

```bash
bun dev:epicenter
```

The tray opens trusted surfaces in separate windows. Deep links use the compiled catalog, for example:

```bash
open 'epicenter://surface/whispering'
open 'epicenter://surface/query'
```

## Build and verify

```bash
# Build Query, Whispering, and the Bun sidecar
bun run --cwd apps/epicenter build:desktop

# Package the complete native application
bun run --cwd apps/epicenter desktop:build

# Typecheck Query plus both Whispering platform conditions
bun run --cwd apps/epicenter typecheck

# Host, routing, sidecar, and surface tests
bun test apps/epicenter/scripts apps/epicenter/src

# Native command and fixture tests
cargo test --manifest-path apps/epicenter/src-tauri/Cargo.toml
```

## Ownership rules

- `src-tauri` owns native commands, permissions, windows, deep links, and packaging.
- `src` owns the Bun host, trusted route catalog, static-asset containment, and Query session.
- `dist` is generated. Never edit it or commit product source beneath it.
- A product SPA owns its UI and browser deployment from its own app folder.
- A multi-host SPA selects implementations through build-time `#platform/*` conditions. Runtime checks guard optional capabilities; they do not choose which implementation was bundled.
- Do not create `apps/epicenter/<surface>` source copies. The build must consume the canonical app source directly.

The durable host and trust decision is recorded in [ADR-0118](../../docs/adr/0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md).
