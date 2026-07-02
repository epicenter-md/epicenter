---
name: wxt
description: WXT browser extension patterns for entrypoints, background service workers, content scripts, side panels, storage, permissions, host permissions, browser compatibility, and build commands. Use when editing apps/tab-manager, wxt.config.ts, src/entrypoints, extension manifests, or @wxt-dev/storage usage.
metadata:
  author: epicenter
  version: '1.0'
---

# WXT Browser Extensions

## Upstream Grounding

Grounding repo: `wxt-dev/wxt` for entrypoint discovery, manifest generation, storage, content scripts, and background service worker lifecycle.

## Epicenter Shape

`apps/tab-manager` is side-panel first: no popup and no content scripts today. The background service worker is minimal and opens the side panel from the extension action.

## Entrypoints

- Entrypoints live under `src/entrypoints`, zero or one level deep.
- Use `defineBackground` for background service workers and `defineContentScript` for content scripts.
- Put browser API runtime work inside the entrypoint `main` function because WXT imports entrypoint modules during build in Node.
- Do not make background `main` async. Kick off async setup inside it.
- Use browser flags and feature detection for cross-browser APIs, not types alone.

## Manifest, Storage, And Commands

- Declare `permissions` and `host_permissions` explicitly in `wxt.config.ts`.
- Use `@wxt-dev/storage` with area-prefixed keys and include the `storage` permission.
- Keep host permissions as narrow as the feature allows. Use `<all_urls>` only when the extension genuinely needs all tab URLs or favicons.
- Local scripts are WXT commands: `wxt prepare`, `wxt build`, `wxt zip`, and browser flags such as `-b firefox`.
- From the repo root, prefer the existing Bun scripts for the Tab Manager app instead of calling package-manager alternatives.
