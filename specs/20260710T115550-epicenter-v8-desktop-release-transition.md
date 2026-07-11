# Epicenter v8 desktop release transition

**Date**: 2026-07-10
**Status**: Draft
**Owner**: Epicenter

## One sentence

Epicenter v8 becomes the only native release, while one final Whispering v7.11.1 release directs existing desktop users to the new application without migrating their local data.

## Overview

The native host architecture can land before public distribution is ready. This spec holds the later release work: one self-contained legacy Whispering transition release, Epicenter-owned desktop packaging and updates, and the public v8 rollout. ADR-0118 remains authoritative for application ownership, trust, identity, and the clean break.

## Current state

After PR #2441 lands:

```text
apps/whispering
|-- browser build ----------> Cloudflare
`-- Epicenter build --------> apps/epicenter/dist/whispering

apps/epicenter
|-- Bun host and trusted surfaces
`-- src-tauri -------------> internal Epicenter.app builds
```

The browser deployment remains active. The internal macOS application builds and opens Whispering, but there is no public Epicenter release workflow, native preview matrix, Developer ID distribution build, notarized DMG, Windows or Linux installer set, or Epicenter-owned updater.

The latest public native release is Whispering v7.11.0. The old release machinery is deleted from the main branch by PR #2441 because Whispering no longer owns a native runtime. Git history retains that machinery for the one-off transition release.

## Target shape

```text
Whispering v7.11.1
  final standalone desktop release
  updater feed remains terminal at v7.11.1
  points users to a stable Epicenter download page

Epicenter v8.0.0
  bundle identifier: so.epicenter
  deep-link scheme: epicenter://
  signed and notarized macOS distribution
  deliberately selected Windows and Linux distributions
  Epicenter-owned update feed and update UI
  Whispering included as a trusted surface
```

Whispering in the browser continues independently and does not inherit the native release version or updater lifecycle.

## Research findings

### The old workflow contains real platform knowledge

The deleted Whispering release and preview workflows were not disposable boilerplate. They provisioned Linux audio and WebKit dependencies, Vulkan on Linux and Windows, SPIR-V headers, LLVM for Windows bindgen, short Windows build paths, native runtime library audits, macOS signing verification, DMG notarization, and AppImage repair.

That behavior should move to Epicenter ownership only when the corresponding distribution target is selected. It should not return under Whispering names.

### The internal macOS signature is not a distribution signature

`apps/epicenter/src-tauri/tauri.conf.json` uses the ad hoc signing identity `-`. This proves bundle structure and nested Bun entitlements locally, but it does not produce a Developer ID application or a notarized artifact accepted by Gatekeeper.

### The Bun sidecar changes the build matrix

`apps/epicenter/scripts/build-sidecar.ts` refuses cross-compilation because Bun compiles the host executable for the current runner. Every shipped architecture needs a matching runner. The old macOS Intel preview cross-compiled Rust from Apple Silicon and cannot be copied unchanged.

### The old app cannot update in place to Epicenter

Whispering and Epicenter use different product names, bundle identifiers, data roots, keychain services, permission identities, and deep-link schemes. The transition release can notify and redirect, but it must not present Epicenter as an in-place updater payload.

## Design decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Native product identity | 2 coherence | `so.epicenter` and `so.epicenter.dev` | ADR-0118 makes Epicenter the flagship native owner. The `.app` suffix adds no product meaning. |
| First unified native version | 3 taste | Epicenter v8.0.0 | The v7 to v8 boundary honestly signals the new application identity and clean break. Future repository releases stay within `8.Y.Z`. |
| Final standalone version | 3 taste | Whispering v7.11.1 | v7.11.0 is the latest public release and the source already carries 7.11.1. |
| Data migration | 2 coherence | No migration | ADR-0118 rejects old-origin and old-app-data readers. Old data remains untouched on disk. |
| Transition mechanism | 2 coherence | Notice and stable download link | Different application identities make an in-place updater handoff misleading. |
| Release timing | Deferred | Internal iteration first | Public release machinery is not required to merge the host architecture. Begin when Epicenter is ready for external desktop users. |
| Initial platform set | Deferred | Decide at release start | Each platform adds build, signing, installer, and runtime audit obligations. |

## Implementation plan

### Phase 1: Freeze the release contract

- [ ] Confirm the initial public platform and architecture set.
- [ ] Confirm `so.epicenter` is available in the Apple developer account and reserve it if needed.
- [ ] Keep the production identity, `epicenter://` scheme, production loopback origin, updater public key, and release asset names stable from the first public build.
- [ ] Rewrite `docs/release-notes/v8.0.0.md` around Epicenter as the native product and Whispering as one included surface.
- [ ] Publish a stable Epicenter download URL that can change its destination without changing old clients.

### Phase 2: Build Epicenter distribution

- [ ] Add an Epicenter-native preview workflow that builds on matching target runners.
- [ ] Port only the platform setup required by the selected matrix from the deleted Whispering setup action.
- [ ] Configure distributable bundle targets, icons, installer metadata, and staged local-transcription libraries under `apps/epicenter/src-tauri`.
- [ ] Add Developer ID signing, hardened-runtime verification, app and DMG notarization, stapling, and Gatekeeper assessment for macOS.
- [ ] Restore the AppImage library repair only if AppImage is selected and the original Wayland failure still reproduces.
- [ ] Audit Windows and Linux installers for the transcribe-cpp runtime libraries before uploading artifacts.
- [ ] Add Epicenter-owned updater configuration, signing, feed generation, and user-facing update flow.
- [ ] Make a draft Epicenter v8.0.0 GitHub release and verify every artifact on a clean machine.

### Phase 3: Publish the terminal Whispering release

- [ ] Create a temporary legacy release branch from `05d9f5ffb8`, the main commit immediately before PR #2441 lands.
- [ ] Make the legacy workflow self-contained on that branch instead of resolving deleted composite actions from `@main`.
- [ ] Add a concise in-app transition notice and release notes that identify v7.11.1 as the final standalone desktop version.
- [ ] Link to the stable Epicenter download URL and explain the new-install, new-permissions, and no-data-migration boundary.
- [ ] Build, sign, notarize, verify, and publish Whispering v7.11.1.
- [ ] Leave the old updater manifest terminal at v7.11.1. Do not point it at an Epicenter installer.

### Phase 4: Publish Epicenter v8

- [ ] Publish the verified Epicenter v8.0.0 release and activate the stable download URL.
- [ ] Update the landing page and repository entry points to download Epicenter rather than Whispering Desktop.
- [ ] Document that old Whispering and Epicenter can coexist, but users should quit or uninstall the old app before enabling the same global shortcut or autostart behavior.
- [ ] Confirm the browser Whispering deployment remains independent and unchanged by the native release.
- [ ] Monitor installer, launch, permission, updater, and local-transcription failures before widening the platform matrix.

### Phase 5: Retire transition scaffolding

- [ ] Delete temporary legacy release branches and workflows after the terminal release is recoverable from its tag and GitHub assets.
- [ ] Move durable operational facts into current release documentation or an ADR amendment where needed.
- [ ] Regenerate `docs/spec-history.md` and delete this completed spec.

## Verification

### Epicenter macOS

- [ ] The downloaded DMG passes `hdiutil verify`.
- [ ] The DMG and nested application validate with `stapler`.
- [ ] Gatekeeper reports `source=Notarized Developer ID`.
- [ ] Both the Epicenter executable and bundled Bun host have the hardened runtime and required JIT entitlements.
- [ ] A clean installation launches Query and Whispering through `epicenter://` deep links.
- [ ] Microphone, Accessibility, global shortcuts, local transcription, tray residency, autostart, and explicit Quit work after fresh permission grants.
- [ ] The updater accepts a signed newer Epicenter build and refuses invalid signatures.

### Other selected platforms

- [ ] Each target builds on a matching runner.
- [ ] Every installer contains the Bun host and required transcribe-cpp runtime libraries.
- [ ] Installation, launch, recording, local transcription, global shortcuts, and uninstall are exercised on a clean machine.

### Transition

- [ ] Whispering v7.11.1 remains installable and its updater feed resolves to itself.
- [ ] The transition notice reaches the stable Epicenter download URL.
- [ ] Epicenter installs beside Whispering without overwriting or deleting old data.
- [ ] Release notes state that settings, recordings, credentials, and permissions do not migrate.

## Open questions

1. **Which platforms belong in Epicenter v8.0.0?**
   - Options: Apple Silicon macOS only; macOS including Intel; the former macOS, Windows, and Linux set.
   - Recommendation: start with the smallest platform set that can be signed, installed, and manually exercised on clean machines. Add platforms only with matching preview coverage.

2. **When should automatic updates enter internal builds?**
   - Recommendation: before the first public Epicenter download. Updating is part of the application owner boundary in ADR-0118, even if internal iteration initially uses manual builds.

3. **Where should the stable transition URL live?**
   - Recommendation: use an Epicenter-owned redirect such as `https://epicenter.so/download`, not a versioned GitHub asset URL.

## Success criteria

- [ ] Epicenter v8.0.0 is the only actively produced native application.
- [ ] Its public macOS artifact is Developer ID signed, notarized, stapled, and Gatekeeper accepted.
- [ ] Every other advertised platform has a matching native preview and clean-machine verification path.
- [ ] Epicenter owns its updater and release artifacts.
- [ ] Whispering v7.11.1 clearly ends the standalone desktop line without attempting an in-place cross-identity update.
- [ ] Browser Whispering continues deploying from `apps/whispering`.
- [ ] No current documentation directs users to a newer standalone Whispering desktop build.

## References

- `docs/adr/0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md`: durable native ownership and clean-break decision.
- `apps/epicenter/src-tauri/tauri.conf.json`: production identity and bundle configuration.
- `apps/epicenter/scripts/build-sidecar.ts`: matching-runner constraint for the Bun host.
- `.github/workflows/auto.release.yml`: disabled repository version and tag automation.
- `.github/workflows/README.md`: current workflow ownership and naming rules.
- Git history for `.github/workflows/release.whispering.yml`: legacy release behavior to consult, not restore under the old owner.
- Git history for `.github/workflows/pr-preview.whispering.yml`: legacy platform matrix and artifact audits.
- Git history for `.github/actions/setup-whispering-build/action.yml`: legacy native toolchain provisioning.
- Git history for `.github/actions/notarize-whispering-dmg/action.yml`: legacy DMG notarization and asset replacement.
- Git history for `.github/actions/process-whispering-appimage/action.yml`: legacy Wayland repair, conditional on reproducing the old failure.
