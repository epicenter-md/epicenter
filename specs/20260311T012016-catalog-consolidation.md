# Catalog Consolidation

Consolidate duplicate dependencies across the monorepo into the workspace catalog so versions are managed in one place.

## Context

The root `package.json` already has a `workspaces.catalog` section with ~40 entries. But many packages still hardcode versions for dependencies that are either already in the catalog or appear in 2+ packages. This creates version drift and makes upgrades harder.

## Changes

### 1. Fix packages using hardcoded versions for deps already in catalog

These packages have a dependency that's in the catalog but use a hardcoded version instead of `catalog:`.

| Package | Dependency | Current (hardcoded) | Catalog version | Action |
|---|---|---|---|---|
| `@epicenter/cli` | `yjs` | `^13.6.29` | `^13.6.29` | Switch to `catalog:` |
| `@epicenter/tab-manager-markdown` | `yjs` | `^13.6.27` | `^13.6.29` | Switch to `catalog:` (also bumps version) |
| `@epicenter/ui` | `@lucide/svelte` | `^0.561.0` | `^0.555.0` | Update catalog to `^0.561.0`, switch to `catalog:` |
| `@epicenter/ui` | `bits-ui` | `^2.14.4` | `2.14.4` | Update catalog to `^2.14.4`, switch to `catalog:` |
| `@epicenter/ui` | `clsx` | `^2.1.1` | `latest` | Switch to `catalog:` |
| `@epicenter/ui` | `tailwind-merge` | `^3.4.0` | `^3.4.0` | Switch to `catalog:` |
| `@epicenter/ui` | `tailwind-variants` | `^3.2.2` | `^3.2.2` | Switch to `catalog:` |
| `@epicenter/tab-manager` | `@standard-schema/spec` | `^1.1.0` (devDeps) | `^1.1.0` | Switch to `catalog:` |
| `server-remote-cloudflare` | `@types/bun` | `^1.3.10` (deps) | `latest` | Switch to `catalog:` |

### 2. Add new entries to catalog for deps appearing in 2+ packages

These dependencies appear in multiple packages with hardcoded versions and should be added to the catalog.

| New catalog entry | Version | Packages that will switch to `catalog:` |
|---|---|---|
| `@tailwindcss/vite` | `^4.1.11` | tab-manager, whispering, landing, fs-explorer, epicenter |
| `@tanstack/ai` | `^0.5.1` | tab-manager, server-remote-cloudflare, ai |
| `@tanstack/ai-anthropic` | `^0.5.0` | tab-manager, server-remote-cloudflare |
| `@tanstack/ai-openai` | `^0.5.0` | tab-manager, server-remote-cloudflare |
| `@hono/standard-validator` | `^0.2.2` | server-remote-cloudflare, server-local |
| `hono-openapi` | `^1.3.0` | server-remote-cloudflare, server-local |
| `fflate` | `^0.8.2` | vault, workspace |
| `@sveltejs/adapter-static` | `^3.0.8` | whispering, epicenter |
| `@sveltejs/adapter-auto` | `^6.1.0` | vault-demo, fs-explorer |
| `@tailwindcss/typography` | `^0.5.19` | whispering, landing (bumps landing from ^0.5.16) |
| `@sindresorhus/slugify` | `^3.0.0` | workspace, epicenter |
| `@tauri-apps/api` | `^2.9.0` | whispering, epicenter |
| `@tauri-apps/plugin-fs` | `^2.4.1` | whispering, epicenter |
| `@tauri-apps/plugin-opener` | `^2.4.0` | whispering, epicenter (bumps epicenter from ^2.3.1) |
| `@tauri-apps/cli` | `^2.9.6` | whispering, epicenter (bumps whispering from ^2.7.1) |
| `bun-types` | `^1.3.0` | vault, fs-explorer |

### 3. Fix catalog version mismatches

| Entry | Current catalog | Should be | Why |
|---|---|---|---|
| `arktype` | `^2.1.27` | `^2.1.29` | Root `dependencies` already has `^2.1.29`; catalog is stale |
| `@lucide/svelte` | `^0.555.0` | `^0.561.0` | UI package already uses newer version |
| `bits-ui` | `2.14.4` (exact) | `^2.14.4` (with caret) | Allow patch updates, consistent with other entries |

### 4. Fix other issues

- [ ] **`@epicenter/landing`**: Remove `@epicenter/ui` from `devDependencies`: it's already in `dependencies`
- [ ] **Root `package.json`**: Remove `arktype: "^2.1.29"` from `dependencies`: it should only be in the catalog (no package at root level needs it directly)

## Execution order

1. Update catalog entries in root `package.json` (update existing + add new)
2. Fix root `package.json` issues (remove duplicate arktype dep)
3. Update all workspace package.json files to use `catalog:`
4. Fix landing page duplicate dep
5. Run `bun install` to regenerate lockfile
6. Typecheck to verify nothing broke

## Out of scope

- Dependencies that only appear in one package (no dedup benefit)
- `workspace:*` references (internal packages. Already correct)
- Updating dependencies to latest upstream versions beyond what's needed for consistency (that's a separate task)

## Review


### Commits

1. `772a525ba`: Updated root catalog: added 16 new entries, fixed 3 version mismatches (arktype ^2.1.27→^2.1.29, @lucide/svelte ^0.555.0→^0.561.0, bits-ui exact→caret).
2. `3b1e9b222`: Switched hardcoded versions to `catalog:` across 14 workspace package.json files. Removed duplicate `@epicenter/ui` from landing devDependencies.
3. `09626d505`: Regenerated lockfile.

### Notes

- **Root `dependencies.arktype`**: The spec called for removing `arktype` from root `dependencies`, but the root package.json has no `dependencies` field. Only `devDependencies`. The catalog entry was the only place it existed at root level, and that was updated.
- **Typecheck results**: 6 packages pass clean. 11 packages have pre-existing type errors unrelated to this change (workspace `NumberKeysOf` missing type, demo-mcp DrizzleDb mismatch, ui svelte-check strictness). No new errors introduced by the catalog consolidation.
- **Version bumps via catalog**: tab-manager-markdown yjs ^13.6.27→^13.6.29, tab-manager @tailwindcss/vite ^4.1.8→^4.1.11, landing @tailwindcss/typography ^0.5.16→^0.5.19, epicenter @tauri-apps/plugin-opener ^2.3.1→^2.4.0, whispering @tauri-apps/cli ^2.7.1→^2.9.6.
