# Whispering Epicenter capability collapse

**Date**: 2026-07-10
**Status**: In Progress
**Owner**: Epicenter

## Product sentence

Epicenter owns machine operations; Whispering composes one complete portable
environment, one structurally desktop-only capability value, and one
always-available workspace; authentication adds remote account resources but
never owns the product.

## V1 completion condition

The Epicenter build supports one complete native workflow:

```text
manual native recording
  -> Rust-owned artifact id
  -> local transcription
  -> cursor or clipboard delivery
  -> global shortcut entry
```

The browser build retains its browser recording, storage, auth, networking,
import, VAD, and download behavior.

V1 is complete when both builds pass, the native workflow passes targeted
tests, no Whispering feature module imports Tauri or raw plugin primitives, and
the old nullable platform graph has no production callers and is deleted.

## Final values

```text
#environment
  complete product operations available in both builds

#desktop
  Epicenter-only product operations, unresolved in browser builds

workspace
  complete local-first state while signed in or signed out

account
  authenticated-only remote resources, nullable only at its root gate

#app-shell
  the single build-selected UI composition seam
```

The environment and desktop contracts expose semantic product operations. They
must not expose `fetch`, raw filesystem paths, `invoke`, plugin command strings,
permission names, or native window constructors.

## V1 refusals

- No arbitrary WebView or plugin HTTP in the Epicenter build.
- No desktop cloud/BYOK transcription until Bun owns explicit provider
  operations.
- No desktop VAD or import until Rust owns Blob/import persistence.
- No plugin-composed filesystem export; add a focused Rust export operation in
  a later wave.
- No native analytics until Epicenter owns its policy, consent, and transport.
- No frontend-created native overlay window. Defer the overlay until Rust owns
  it on every supported platform.
- No nullable required desktop capabilities.
- No compatibility aliases for the old `#platform/*` graph after callers move.

## Waves

### Wave 1: contracts and proof harness

- Add direct `WhisperingEnvironment` and `WhisperingDesktop` contracts.
- Rename the active workspace opener around its actual always-available job.
- Add completeness, forbidden-import, signed-out workspace, and build-selection
  tests.

### Wave 2: browser composition root

- Compose browser auth, recording, artifacts, transcription, downloads, text,
  and notifications behind one complete environment.
- Add the browser app shell.
- Keep the old graph on disk while callers still import it.

### Wave 3: Epicenter composition roots

- Build the portable Epicenter environment and desktop-only value from the
  focused generated Epicenter command contract.
- Keep only the V1 manual/local workflow.
- Add the Epicenter app shell and remove unsupported desktop UI entry points.

### Wave 4: caller migration

- Move portable callers to `#environment`.
- Move desktop-only callers to `#desktop` or the Epicenter app shell.
- Move workspace callers to the always-available workspace runtime.
- Keep account-only resources behind one authenticated gate.

### Wave 5: rollback point

- Stop all production imports of the old `#platform/*` graph.
- Leave the old files on disk.
- Verify browser and Epicenter typechecks, builds, tests, and the native V1
  workflow.

### Wave 6: deletion

- Delete old import-map entries, nullable Tauri namespace, one-purpose platform
  barrels, direct plugin imports and dependencies, stale permissions, stale
  tests, and stale documentation.
- Re-run the full verification and vocabulary sweep.

## Verification

- Both environment factories return complete, non-null contracts.
- `#desktop` has no browser implementation and only Epicenter root/adapter files
  import it.
- Whispering feature code contains no `@tauri-apps/*`, raw `invoke`, `plugin:`,
  `WebviewWindow`, or raw filesystem APIs.
- A signed-out Whispering workspace opens, becomes ready, and persists a product
  fact.
- Browser output contains no Tauri implementation.
- Epicenter generated bindings and ACL cover every projected V1 operation and no
  generic plugin family.
- Packaged debug origin 39131 and release origin 39130 can call a harmless
  projected command.
- Manual record, stop, artifact read, local transcribe, delivery, shortcut,
  cancel, and cleanup paths pass.

## Durable follow-up

Delete this spec when the V1 completion condition passes. Record any changed
durable ownership decision as an ADR amendment before deletion.
