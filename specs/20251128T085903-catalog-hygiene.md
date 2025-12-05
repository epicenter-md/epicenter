# Catalog & Dependency Hygiene Plan

## Overview

This document outlines a comprehensive plan to improve dependency management in the monorepo by:
1. Updating catalog versions to latest
2. Ensuring all packages use `catalog:` references where applicable
3. Adding commonly-used packages to the catalog
4. Updating non-catalog dependencies

---

## Part 1: Catalog Version Updates

### Safe to Update Immediately (18 packages)

| Package | Current | Latest | Change |
|---------|---------|--------|--------|
| typescript | ^5.8.3 | ^5.9.3 | Minor |
| eslint | ^9.30.1 | ^9.39.1 | Minor |
| prettier | ^3.6.2 | ^3.7.1 | Minor |
| svelte | ^5.38.6 | ^5.45.2 | Minor |
| @sveltejs/kit | ^2.37.0 | ^2.49.0 | Minor |
| @sveltejs/vite-plugin-svelte | ^6.1.3 | ^6.2.1 | Minor |
| svelte-check | ^4.2.1 | ^4.3.4 | Minor |
| vite | ^7.0.5 | ^7.2.4 | Minor |
| tailwindcss | ^4.1.11 | ^4.1.17 | Patch |
| tailwind-merge | ^3.3.1 | ^3.4.0 | Minor |
| mode-watcher | ^1.0.8 | ^1.1.0 | Minor |
| svelte-sonner | ^1.0.5 | ^1.0.6 | Patch |
| @lucide/svelte | ^0.536.0 | ^0.555.0 | Minor |
| drizzle-kit | ^0.31.4 | ^0.31.7 | Patch |
| drizzle-orm | ^0.44.3 | ^0.44.7 | Patch |
| arktype | ^2.1.20 | ^2.1.27 | Patch |
| nanoid | ^5.1.5 | ^5.1.6 | Patch |
| turbo | ^2.5.8 | ^2.6.1 | Minor |

### Recommend Using "latest" Keyword

These stable utilities rarely have breaking changes:

| Package | Recommendation |
|---------|----------------|
| clsx | Change to `"latest"` |
| nanoid | Change to `"latest"` |
| concurrently | Change to `"latest"` |

Note: `@biomejs/biome` already uses `"latest"` correctly.

### Requires Careful Testing (Breaking Changes)

| Package | Current | Latest | Risk |
|---------|---------|--------|------|
| @types/node | ^22.18.10 | 24.10.1 | **MAJOR** - Match to Node runtime |
| zod | ^3.25.67 | 4.1.13 | **MAJOR** - v4 breaking changes |
| tailwind-variants | ^1.0.0 | 3.2.2 | **MAJOR** - API changes |
| bits-ui | 2.8.10 | 2.14.4 | MINOR but pinned - UI testing needed |

### Keep Pinned (Intentional)

| Package | Current | Reason |
|---------|---------|--------|
| @tanstack/svelte-table | 9.0.0-alpha.10 | Alpha for Svelte 5 compatibility |
| bits-ui | 2.8.10 | Component library, needs explicit updates |

---

## Part 2: Missing `catalog:` References

### Packages Not Using Catalog (Should Be Fixed)

| Package.json | Dependency | Current Value | Should Be |
|--------------|------------|---------------|-----------|
| apps/epicenter | arktype | ^2.1.20 | catalog: |
| apps/epicenter | svelte | ^5.37.2 | catalog: |
| apps/epicenter | tailwindcss | ^4.1.11 | catalog: |
| apps/epicenter | typescript | ^5.9.2 | catalog: |
| apps/api | nanoid | ^5.0.9 | catalog: |
| examples/content-hub | drizzle-orm | ^0.44.7 | catalog: |
| examples/content-hub | drizzle-kit | ^0.31.4 | catalog: |
| packages/constants | typescript | ^5.8.3 | catalog: |
| packages/constants | @types/node | ^20.11.5 | catalog: |
| packages/epicenter | arktype | ^2.1.25 | catalog: |
| packages/epicenter | nanoid | ^5.1.5 | catalog: |
| packages/epicenter | drizzle-orm | ^0.44.7 | catalog: |
| packages/epicenter | drizzle-kit | ^0.31.5 | catalog: |
| packages/epicenter | typescript | ^5.7.3 | catalog: |
| packages/epicenter | @types/node | ^24.10.0 | catalog: |
| packages/svelte-utils | svelte | 5.14.4 | catalog: |
| packages/svelte-utils | @types/node | ^22.15.32 | catalog: |
| packages/svelte-utils | typescript | ^5.8.3 | catalog: |
| packages/ui | @lucide/svelte | ^0.525.0 | catalog: |
| packages/ui | typescript | ^5.7.3 | catalog: |
| root package.json | eslint | ^9.37.0 | catalog: |
| root package.json | prettier | ^3.6.2 | catalog: |

**Total: 21 dependencies need to switch to `catalog:`**

---

## Part 3: New Packages to Add to Catalog

These dependencies appear in multiple packages and should be centralized:

| Dependency | Occurrences | Recommended Version |
|------------|-------------|---------------------|
| @types/bun | 4 packages | latest |
| wrangler | 3 packages | ^4.51.0 |
| yargs | 3 packages | ^18.0.0 |
| @types/yargs | 2 packages | ^17.0.35 |
| hono | 2 packages | ^4.10.7 |

---

## Part 4: Non-Catalog Dependency Updates

### Critical Updates (Major Versions)

| Package | Location | Current | Latest | Notes |
|---------|----------|---------|--------|-------|
| openai | apps/whispering | ^5.7.0 | 6.9.1 | Breaking changes likely |
| yargs | apps/cli | ^17.7.2 | 18.0.0 | Test CLI commands |
| @eslint/compat | root | ^1.4.0 | 2.0.0 | Test linting |
| paneforge | packages/ui | ^1.0.0-next.5 | 1.0.2 | Pre-release to stable |

### High Priority Updates (Significantly Behind)

| Package | Location | Current | Latest |
|---------|----------|---------|--------|
| posthog-js | apps/epicenter | ^1.258.5 | 1.298.1 |
| @anthropic-ai/sdk | apps/whispering | ^0.55.0 | 0.71.0 |
| groq-sdk | apps/whispering | ^0.25.0 | 0.37.0 |
| astro | apps/epicenter | ^5.12.4 | 5.16.2 |
| dexie | apps/whispering | ^4.0.11 | 4.2.1 |

### Safe Patch Updates

All @tauri-apps/plugin-* packages in apps/whispering have patch updates available.

---

## Implementation Plan

### Commit 1: Update Catalog Versions
- [x] Update all safe packages to latest versions
- [x] Change clsx, nanoid, concurrently to "latest"
- [x] Keep bits-ui and @tanstack/svelte-table pinned

### Commit 2: Fix catalog: References
- [x] Update all 21 dependencies to use `catalog:`
- [x] Fix root package.json eslint and prettier

### Commit 3: Add New Packages to Catalog
- [x] Add @types/bun, wrangler, yargs, @types/yargs, hono
- [x] Update all usages to `catalog:`

### Commit 4: Update Non-Catalog Dependencies (Optional)
- [ ] Update safe minor/patch versions
- [ ] Create separate PR for major version updates

---

## Version Inconsistencies Found

| Package | Versions in Use | Catalog Version |
|---------|-----------------|-----------------|
| typescript | 5.7.3, 5.8.3, 5.9.2, 5.9.3 | ^5.8.3 |
| @types/node | 20.11.5, 22.15.32, 22.18.10, 24.10.0 | ^22.18.10 |
| arktype | 2.1.20, 2.1.25 | ^2.1.20 |
| svelte | 5.14.4, 5.37.2, 5.38.6 | ^5.38.6 |
| nanoid | 5.0.9, 5.1.5 | ^5.1.5 |

Using `catalog:` references will automatically resolve these inconsistencies.

---

## Review Notes

### Changes Made

**Catalog Updates (18 packages updated to latest):**
- typescript: ^5.8.3 → ^5.9.3
- eslint: ^9.30.1 → ^9.39.1
- prettier: ^3.6.2 → ^3.7.1
- svelte: ^5.38.6 → ^5.45.2
- @sveltejs/kit: ^2.37.0 → ^2.49.0
- @sveltejs/vite-plugin-svelte: ^6.1.3 → ^6.2.1
- svelte-check: ^4.2.1 → ^4.3.4
- vite: ^7.0.5 → ^7.2.4
- tailwindcss: ^4.1.11 → ^4.1.17
- tailwind-merge: ^3.3.1 → ^3.4.0
- mode-watcher: ^1.0.8 → ^1.1.0
- svelte-sonner: ^1.0.5 → ^1.0.6
- @lucide/svelte: ^0.536.0 → ^0.555.0
- drizzle-kit: ^0.31.4 → ^0.31.7
- drizzle-orm: ^0.44.3 → ^0.44.7
- arktype: ^2.1.20 → ^2.1.27
- turbo: ^2.5.8 → ^2.6.1

**Changed to "latest" keyword:**
- clsx
- nanoid
- concurrently

**New packages added to catalog:**
- @types/bun: latest
- @types/yargs: ^17.0.35
- wrangler: ^4.51.0
- yargs: ^18.0.0
- hono: ^4.10.7

**Files modified to use catalog: references:**
- package.json (root): eslint, prettier, @types/bun
- apps/api/package.json: nanoid, hono, wrangler
- apps/cli/package.json: yargs
- apps/epicenter/package.json: arktype, svelte, tailwindcss, typescript
- apps/posthog-reverse-proxy/package.json: typescript, wrangler
- apps/whispering/package.json: wrangler
- examples/basic-workspace/package.json: yargs, @types/bun, @types/yargs
- examples/content-hub/package.json: drizzle-orm, drizzle-kit, @types/bun
- packages/constants/package.json: @types/node, typescript
- packages/epicenter/package.json: arktype, drizzle-orm, hono, nanoid, yargs, @types/node, @types/yargs, drizzle-kit, typescript, @types/bun
- packages/svelte-utils/package.json: svelte, @types/node, typescript
- packages/ui/package.json: @lucide/svelte, svelte-check, typescript

**Not updated (breaking changes):**
- zod: Staying at ^3.25.67 (v4 has breaking changes)
- tailwind-variants: Staying at ^1.0.0 (v3 has breaking changes)
- @types/node: Staying at ^22.18.10 (major version; should match Node runtime)

**Not updated (intentionally pinned):**
- bits-ui: 2.8.10 (component library)
- @tanstack/svelte-table: 9.0.0-alpha.10 (alpha for Svelte 5)
