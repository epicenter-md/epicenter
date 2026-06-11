# Remove `apps/epicenter/` Tauri App

**Date:** 2026-03-12
**Status:** Implemented

> **Path note (2026-05-22):** The rebuild references below point at older sidecar specs that used `~/.epicenter/workspaces/`. That global workspace registry is superseded. Treat those references as historical architecture context, not current path guidance.

## Context

`apps/epicenter/` is a Tauri desktop app (SvelteKit + Rust) built on an obsolete architecture. It uses hardcoded workspace templates, direct Tauri FS plugin persistence, and a model that every recent spec has moved away from. The codebase has evolved toward a Bun sidecar architecture where:

- Workspaces are dynamically loaded `epicenter.config.ts` files from `~/.epicenter/workspaces/`
- The Tauri app becomes a thin shell that spawns a sidecar and points a WebView at it
- Persistence moves to the sidecar (Bun-native), not the frontend (Tauri FS plugins)
- Newer workspace apps (fuji, honeycrisp) are web-only SvelteKit apps that don't use Tauri at all

### What's Being Removed

44 source files across:

| Component | Files | Why it's dead |
|---|---|---|
| Hardcoded templates (entries, whispering) | 3 | Replaced by dynamic `epicenter.config.ts` loading (sidecar spec Phase 2) |
| Static workspace viewer (GenericTableViewer, GenericKvViewer) | 5 | Designed for the old direct-Tauri-FS model |
| Dynamic workspace CRUD (service, queries) | 3 | Calls `@tauri-apps/plugin-fs` directly instead of sidecar HTTP |
| Yjs persistence + workspace loading | 4 | `workspace-persistence.ts` explicitly marked for deletion in sidecar spec |
| Components (sidebars, dialogs, breadcrumbs) | 8 | Coupled to the template model |
| Routes (home, workspace, settings, tables, static viewer) | 11 | Tied to the template model |
| Tauri Rust backend (lib.rs, Cargo.toml, tauri.conf.json) | 3 | 63 lines of Rust. Not much to preserve. |
| Slug utilities | 3 | Trivially replaceable |
| Query client (TanStack Query setup) | 2 | Boilerplate `QueryClient` init |
| Build config (vite, svelte, tsconfig) | 4 | Standard config |

### What's NOT Being Removed

- All specs referencing `apps/epicenter/` are kept as historical record (60+ specs)
- `docs/articles/tauri-bun-dual-backend-architecture.md` stays (reference for rebuild)
- `packages/workspace/` stays (epicenter's core library, used by everything)
- `packages/ui/` stays (shared UI components)

### Dependency Check

- `@epicenter/app` is not imported by any other package in the monorepo
- No CI workflows reference `@epicenter/app`
- No turbo.json references to epicenter specifically
- The monorepo uses `apps/*` workspace pattern: removal is automatic

### Precedent

This follows the exact pattern used for removing `apps/sh/` (the assistant) in `specs/20251121T171358 remove-assistant-rebuild.md`: remove from main, rebuild on a fresh branch when the architecture is ready.

### Reference Specs for Rebuild

When the sidecar architecture is ready, these specs describe the target:

- `specs/20260225T000000-bun-sidecar-workspace-modules.md`: Phase 1-5 roadmap for the sidecar
- `specs/20260304T120000-hub-sidecar-architecture.md`: Two-plane hub/sidecar design
- `specs/20260225T210000-workspace-apps-orchestrator.md`: Workspace-as-app model
- `docs/articles/tauri-bun-dual-backend-architecture.md`: Rust sidecar spawning code

## Todo

- [x] Delete `apps/epicenter/` entirely
- [x] Update `AGENTS.md` to remove `apps/epicenter/` from the structure description
- [x] Run `bun install` to update lockfile
- [x] Verify no typecheck regressions (epicenter is a leaf node, so there shouldn't be any)

## Review

**Completed:** 2026-03-12

### Summary

Deleted the entire `apps/epicenter/` Tauri app (75 tracked files including source, Rust backend, icons, config, and local specs). Updated `AGENTS.md` to reflect the current app structure. Lockfile cleaned automatically (`Removed: 1` workspace).

### Verification

- `bun install` completed cleanly with `Removed: 1`
- `bun typecheck` shows zero new errors. One pre-existing failure in `@epicenter/ai` (unrelated `NumberKeysOf` type error in `@epicenter/workspace`): confirmed identical before and after removal.
- `grep -r "@epicenter/app"` across all `package.json` files returns zero results.

### Deviations from Spec

None. Straightforward deletion.

### Pre-existing Issues Noted

- `@epicenter/ai` has type errors against `@epicenter/workspace` (`NumberKeysOf` not found, type indexing issue). These existed before this change and are unrelated.
