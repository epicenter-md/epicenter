# Dev macOS Accessibility identity

`bun run dev` launches Whispering under its own macOS identity,
`so.epicenter.whispering.dev`, separate from the released **Whispering**
(`so.epicenter.whispering`). Grant Accessibility once and paste at cursor keeps
working across rebuilds.

Because dev runs a bare binary rather than a `.app`, its System Settings entry
may be labelled `whispering` rather than `Whispering Dev`; what is guaranteed is
that it is a *distinct* entry from production, so granting one never touches the
other.

## Why this is not just a flag

`tauri dev` runs the bare `target/debug/whispering` binary, not a `.app` bundle,
and it ignores `bundle.macOS.signingIdentity`. Cargo's linker leaves that binary
ad-hoc signed, so its code-signing identity is its cdhash, which changes on every
relink. macOS Accessibility (TCC) keys the grant on that identity, so each Rust
rebuild looked like a brand-new app and the grant went stale. The Rust
supervisor then reported `DictationCapability::Broken`.

The fix is a stable designated requirement, not a certificate. Tauri's
`build.runner` hook (`tauri.dev.macos.conf.json`) points `tauri dev` at
[`dev-codesign-runner.sh`](./dev-codesign-runner.sh), which builds the binary,
overwrites its signature, and then `exec`s it:

```sh
codesign --force \
	--sign - \
	--identifier so.epicenter.whispering.dev \
	--requirements '=designated => identifier "so.epicenter.whispering.dev"' \
	--entitlements src-tauri/entitlements.plist \
	target/debug/whispering
```

The `--sign -` identity is still ad-hoc, but the embedded designated requirement
is explicit and identifier-only. TCC keys the dev grant to that requirement, so
the grant survives relinks even though the binary's cdhash changes.

This is intentionally local-only. Any local process could sign itself ad-hoc
with `so.epicenter.whispering.dev` and satisfy the same requirement. That tradeoff
is acceptable for a dev-only identity because it avoids keychain prompts,
certificate trust repair, and machine-specific signing state. Production keeps
its separate identifier, `so.epicenter.whispering`, and must never use this dev
signing model.

## Granting and resetting

First `bun run dev` after this change re-prompts for Accessibility (the identity
changed). Grant the new entry in System Settings > Accessibility, once.

To start clean (the binary must have launched at least once so the entry exists):

```sh
tccutil reset Accessibility so.epicenter.whispering.dev
```

Then relaunch dev and grant Accessibility again.

## Diagnosing

```sh
bun run dev:doctor
```

prints the dev binary path, its signed identifier, signature, designated
requirement, whether the fixed requirement is present, and the reset command.
Live trust, the current `DictationCapability`, and the macOS Accessibility-grant watch
are owned by the running app's supervisor
(`src/keyboard/mod.rs`) and show up in the app and the Tauri log.
