# 0153. Trusted apps are source-built static catalog members

- **Status:** Superseded
- **Date:** 2026-07-19
- **Superseded by:** [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md). Admission accepts an inert built folder from any provenance; the source-build mechanism, composition-root source convention, and build-time trust ceremony below are withdrawn. ADR-0179 restates the runtime trust model, immutable-generation catalog, and app-window authority that remain in force.
- **Supersedes:** the future third-party installation shape in [ADR-0111](0111-super-chat-v1-exposes-built-in-epicenter-apps-and-defers-extension-surfaces.md). App installation does not begin with a runtime manifest, permission grant, or installed-app registry.
- **Amends:** [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md) at the app-admission and native-authority boundary, and [ADR-0152](0152-epicenter-home-is-a-shell-above-workspaces.md) at the deferred third-party installation boundary.
- **Relates:** [ADR-0066](0066-runtime-portability-is-per-concern-injection-not-a-runtime-object.md), [ADR-0080](0080-the-super-app-is-a-desktop-host-cross-device-is-remote-access-to-the-session-not-a-per-app-capability-plane.md)

## Context

ADR-0118 established the decisive security fact: every Epicenter SPA runs on
one Bun-owned browser origin inside one signed Tauri application. Those SPAs
share cookies, browser storage, same-origin APIs, and the consequences of a
frontend compromise. A per-app permission declaration would describe an
isolation boundary the runtime does not have.

ADR-0111 deferred third-party installation until Epicenter had designed app
manifests, permissions, pinning, and installed state. That was the right refusal
while an installed app meant code loaded into the host process. It is the wrong
starting point for a trusted-source product. A user who receives complete SPA
source can inspect it, edit it, keep it in Git, and build the exact program the
host will serve.

Source acquisition, source execution, and runtime authority are different
boundaries. JSRepo, Git, an archive, or a local copy can put files in a source
tree. Running a package install or build script executes arbitrary code with the
user's machine privileges. Serving the resulting JavaScript gives that app the
shared browser origin and the native commands exposed to trusted app windows.
Collapsing these boundaries into an install button would obscure the strongest
authority transition in the system.

## Decision

Epicenter apps are trusted, static SPA catalog members. Epicenter ships a
prebuilt default catalog. A developer may add or replace catalog members by
building complete source trees from an ordinary, user-owned composition
repository. The desktop runtime consumes only validated static outputs and a
derived catalog. It does not load app source, execute app server modules, or
track how source arrived.

The source convention is:

```txt
<composition-root>/
  apps/
    <id>/
      package.json
      bun.lock
      ...source
      dist/
        index.html
        ...static assets
```

`<id>` is the direct child directory name and matches `[a-z0-9-]+`.
`package.json` provides a `build` script. Each member is independently
installable from its app root, with dependency versions pinned by `bun.lock`.
`bun run build` must produce `dist/` whose files work when served below
`/apps/<id>/`. There is no Epicenter app manifest. If a future host
compatibility requirement earns authored metadata, it may use one optional
`epicenter` key in `package.json`; that key is not created speculatively.

An Epicenter-owned build command operates on a composition root and, only after
an explicit trust confirmation, runs `bun install --frozen-lockfile` and
`bun run build` from each app root, validates every output, and copies the
complete result into a host-owned derived catalog directory. The confirmation
states that dependency installation and build scripts may execute arbitrary
code as the current user. A failed build or validation leaves the selected
catalog unchanged. A successful build publishes one complete immutable
generation beneath the host-owned catalog root, then atomically replaces a
small `current` pointer. Each process resolves that pointer once at startup and
binds its asset resolvers to the selected generation directory. Publication
never mutates an existing generation, so a running process cannot observe a
partial or newly promoted catalog. The new generation takes effect after
Epicenter restarts.

Generation IDs are opaque, sortable identifiers, not content hashes. Their job
is to fence one process lifetime from later publication, not to prove artifact
identity or provide rollback. Old generations are not deleted automatically
because another running process may still serve one. Git owns rollback: revert
the source and publish a fresh generation. Explicit maintenance may remove
generations only when no process can still reference them.

The editable composition repository never lives inside Epicenter's app-data
tree. The build command receives it explicitly, initially from its working
directory or a command option. The desktop does not persist the source path.
Host-owned app data may contain disposable built output and the derived catalog,
but no source checkout, per-app installation row, permission grant, or update
record.

The catalog is generated from validated output, not authored by the app. It
derives the app ID from the directory, the title from
`manifest.webmanifest` or the document `<title>`, and the icon from
`manifest.webmanifest` or `<link rel="icon">`. Missing optional presentation
metadata falls back to the ID and Epicenter's default icon. The runtime needs
only enough catalog data to list an app, resolve its static root, and open its
window.

Bun serves every catalog member through one generic, containment-checked static
asset resolver at `/apps/<id>/`. Existing files are served directly. A missing
extensionless path falls back to that app's `index.html`; a missing asset does
not. User-built output with the same ID as a bundled app replaces that bundled
app in the active catalog. The build confirmation lists every replacement
prominently. There is no second permission ceremony because replacement does
not increase authority.

Rust opens catalog entries through one validated app-window path. App window
labels use one reserved pattern derived from the validated app ID, and one
Tauri capability glob grants every such window the fixed trusted-app command
surface. Internal windows such as a recording overlay may keep narrower
capabilities because they are host mechanisms, not app catalog members. Rust
does not mirror the app catalog as an enum or accept an arbitrary URL from the
SPA.

The trusted-app command surface includes native HTTP transport with unrestricted
HTTP and HTTPS URL scope. Browser builds continue to use browser `fetch` and
its CORS rules; Epicenter desktop builds may use Tauri's HTTP plugin. This is an
explicit reversal of ADR-0118's refusal of a generic HTTP proxy. On a shared
origin with fully trusted apps, a semantic network broker would recreate a
permission system without creating isolation.

Full app trust does not mean every Tauri plugin is enabled. The fixed command
surface is the complete authority Epicenter intentionally offers to app
windows. It does not include a generic shell, process launcher, filesystem
handle, SQL executor, arbitrary Rust command, or Bun server module. This fixed
runtime floor still limits a compromised served SPA, even though source build
admission is more powerful because build scripts execute outside that floor.

Source delivery is outside the application contract. The first version does
not embed or invoke JSRepo and does not provide `app add` or `app update`.
Developers may use Git, JSRepo, an archive, or ordinary file operations to put
source in the composition tree, review the resulting Git diff, and then invoke
the Epicenter build command. The existing JSRepo recipe-block registry remains
separate. If repeated acquisition friction later earns an Epicenter command, it
must fetch files without executing registry-controlled configuration or build
code and must stop before the build confirmation.

## Consequences

- The default catalog remains a normal non-developer product. Source-built
  third-party apps are deliberately a developer feature.
- There are no capability IDs, per-method grants, app permission declarations,
  permission UI, automatic source updates, or runtime installed-app database.
- A malicious admitted app can read same-origin Epicenter data and exfiltrate it
  through native HTTP. The protection is source and build admission, not a
  fictional per-app sandbox.
- Typed concern-specific clients remain useful for portability and ergonomics.
  They are not authority boundaries and do not combine into one `AppRuntime`
  object.
- App code is static client code. Durable background processes remain external
  tools or host-owned services.
- Built outputs are never served from the editable source tree. Partial edits
  and failed builds cannot change the active catalog.
- Published generations accumulate until explicit maintenance proves they are
  no longer referenced by a running process.
- Prebuilt third-party distribution to non-developers is a different product.
  It would require publisher trust and artifact signing and must be decided in
  a later ADR rather than added as installer convenience.

## First proof and backward path

The first proof is one trivial local app built from a composition tree. It must
appear in the derived catalog, open through the dynamic Rust window path, and
complete an external request through Tauri's HTTP plugin. This proves the source
convention, generic asset resolver, dynamic capability glob, and fixed authority
before Epicenter builds source acquisition.

After that proof:

1. Build the generic output validator, derived catalog, contained asset server,
   and dynamic window path beside the current closed catalog.
2. Produce Home and Whispering as bundled members of the same output contract.
3. Stop importing the TypeScript and Rust closed surface catalogs while leaving
   their files in place as the rollback point.
4. Verify the desktop typecheck, Bun host tests, Rust tests, packaged sidecar
   smoke, deep links, SPA fallback, containment, and native HTTP request.
5. Delete the duplicated route tables, enumerated app capability labels, and
   Home and Whispering static-serving special cases.
6. Add the composition build command and full trust confirmation. Keep source
   acquisition out until real use demonstrates that Git and JSRepo are
   insufficient.

## Considered alternatives

- **Build a manifest and per-app permission system.** Rejected because one
  shared browser origin and one trusted desktop host cannot enforce the model
  that the manifest would advertise.
- **Make JSRepo the installer.** Rejected for the first version because
  acquisition already works independently, while embedding its config,
  transforms, dependency installation, and update lifecycle would create a
  subsystem outside the runtime contract.
- **Wrap acquisition, review, install, and build in one Epicenter command.**
  Rejected because it compresses the pause where the user inspects the source
  and hides the fact that dependency installation and build scripts execute
  with ambient machine authority.
- **Serve app output directly from the composition tree.** Rejected because an
  incomplete edit or failed build could become live runtime code.
- **Atomically replace one stable catalog directory.** Rejected because a
  running resolver reads asset paths on every request. Replacing that directory
  would hot-swap files inside an already-running process even if the directory
  rename itself were atomic.
- **Content-address catalog generations.** Rejected because the generation ID
  is a lifetime fence, not an integrity or distribution primitive. An opaque ID
  avoids hashing every asset while immutable directories provide the required
  activation behavior.
- **Keep a current and previous generation manager.** Rejected because an
  atomic successful publication plus Git revert and rebuild provides one clear
  recovery path without durable generation state.
- **Delete the previous generation during publication.** Rejected because a
  process that started before publication may still serve it. Safe reclamation
  needs an explicit proof that no process retains the generation.
- **Broker outbound HTTP semantically.** Rejected because it recreates grants
  without creating an honest isolation boundary.
