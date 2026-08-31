---
'@epicenter/auth': minor
---

Delete the Node machine-auth surface. `@epicenter/auth/node` is gone, along with `loginWithOob`, `status`, `logout`, `createMachineAuthClient`, `machineAuthFilePath`, `MachineAuthStorageError`, and `resolveMachineAuthClient`.

Epicenter has no general-purpose CLI, so nothing but a terminal ever reached these. Authentication is owned entirely by the apps: the browser, extension, Tauri, desktop-host, and same-origin cookie clients are unchanged, and `createAppAuthClient` remains the one dispatcher. The static-bearer self-host path is still available to apps through `createInstanceTokenAuth`; what went away is the headless environment-variable resolver and the on-disk `0o600` session file in front of it.

The `epicenter-cli` OAuth client and its `/cli-callback` redirect page are removed with it. `buildTrustedOAuthClients()` no longer takes a deployment base URL, because every remaining trusted client owns its own callback surface.
