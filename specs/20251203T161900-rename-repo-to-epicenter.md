# Rename @repo/* to @epicenter/* (Issue #772)

## Summary

Migrate all packages from `@repo/*` scope to `@epicenter/*` scope and set appropriate `private: true` flags on internal-only packages.

## Current State

| Package | Current Name | Private? |
|---------|--------------|----------|
| packages/ui | `@repo/ui` | - |
| packages/epicenter | `@epicenter/hq` | - |
| packages/config | `@repo/config` | true |
| packages/svelte-utils | `@repo/svelte-utils` | true |
| packages/constants | `@repo/constants` | - |
| packages/shared | `@repo/shared` | true |
| packages/vault-core | `@repo/vault-core` | - |
| apps/epicenter | `epicenter` | - |
| apps/posthog-reverse-proxy | `@epicenter/posthog-reverse-proxy` | true |
| apps/cli | `@epicenter/code` | - |
| apps/whispering | `@repo/whispering` | - |
| apps/demo-mcp | `@epicenter/demo-mcp` | true |

## Target State

| Package | New Name | Private? | Rationale |
|---------|----------|----------|-----------|
| packages/ui | `@epicenter/ui` | true | Internal design system |
| packages/epicenter | `@epicenter/hq` | - | Public SDK |
| packages/config | `@epicenter/config` | true | Internal build configs |
| packages/svelte-utils | `@epicenter/svelte-utils` | true | Internal utilities |
| packages/constants | `@epicenter/constants` | true | Internal constants |
| packages/shared | `@epicenter/shared` | true | Internal shared code |
| packages/vault-core | `@epicenter/vault-core` | - | Public adapter core |
| apps/epicenter | `@epicenter/web` | true | Marketing site |
| apps/posthog-reverse-proxy | `@epicenter/posthog-reverse-proxy` | true | Internal infra |
| apps/cli | `@epicenter/code` | - | Public CLI |
| apps/whispering | `@epicenter/whispering` | true | Desktop app |
| apps/demo-mcp | `@epicenter/demo-mcp` | true | Demo app |

## Migration Tasks

- [x] **1. Update package.json names and private flags**
  - [x] `packages/ui/package.json`: `@repo/ui` → `@epicenter/ui`, add `"private": true`
  - [x] `packages/config/package.json`: `@repo/config` → `@epicenter/config`
  - [x] `packages/svelte-utils/package.json`: `@repo/svelte-utils` → `@epicenter/svelte-utils`
  - [x] `packages/constants/package.json`: `@repo/constants` → `@epicenter/constants`, add `"private": true`
  - [x] `packages/shared/package.json`: `@repo/shared` → `@epicenter/shared`
  - [x] `packages/vault-core/package.json`: `@repo/vault-core` → `@epicenter/vault-core`
  - [x] `apps/epicenter/package.json`: `epicenter` → `@epicenter/web`, add `"private": true`
  - [x] `apps/whispering/package.json`: `@repo/whispering` → `@epicenter/whispering`, add `"private": true`

- [x] **2. Update all imports in source files** (98 files affected)
  - [x] Replace `@repo/ui` → `@epicenter/ui`
  - [x] Replace `@repo/config` → `@epicenter/config`
  - [x] Replace `@repo/svelte-utils` → `@epicenter/svelte-utils`
  - [x] Replace `@repo/constants` → `@epicenter/constants`
  - [x] Replace `@repo/shared` → `@epicenter/shared`
  - [x] Replace `@repo/vault-core` → `@epicenter/vault-core`
  - [x] Replace `@repo/whispering` → `@epicenter/whispering`
  - [x] Replace `@repo/extension` → `@epicenter/extension` (in commented code)

- [x] **3. Run bun install to regenerate lockfile**

- [x] **4. Verify build passes**
  - [x] `@epicenter/web` builds successfully
  - [ ] `@epicenter/whispering` has pre-existing dependency issue with `@mistralai/mistralai` and `zod` (unrelated to rename)

## Review

### Changes Made

Renamed all packages from `@repo/*` scope to `@epicenter/*`:

| Before | After | Private |
|--------|-------|---------|
| `@repo/ui` | `@epicenter/ui` | true |
| `@repo/config` | `@epicenter/config` | true |
| `@repo/svelte-utils` | `@epicenter/svelte-utils` | true |
| `@repo/constants` | `@epicenter/constants` | true |
| `@repo/shared` | `@epicenter/shared` | true |
| `@repo/vault-core` | `@epicenter/vault-core` | false |
| `epicenter` | `@epicenter/web` | true |
| `@repo/whispering` | `@epicenter/whispering` | true |

### Files Modified

- 8 `package.json` files updated with new names and private flags
- ~98 source files updated with new import paths
- `bun.lock` regenerated

### Pre-existing Issues Found

1. `@epicenter/code` (apps/cli) fails `bun run check` because `tsc` is not found (missing typescript devDependency)
2. `@epicenter/whispering` build fails due to `@mistralai/mistralai` package requiring `zod/v3` which doesn't exist in the installed zod version

### Notes

- The `private: true` flag prevents accidental npm publishing; all packages remain open source on GitHub
- Packages marked as public (`@epicenter/hq`, `@epicenter/vault-core`, `@epicenter/code`) are intended for npm publishing
