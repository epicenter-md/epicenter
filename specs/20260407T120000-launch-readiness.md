# Launch Readiness: Versioning, Publishing, and Public Surface Fixes

**Date**: 2026-04-07
**Status**: In Progress
**Author**: AI-assisted

## Overview

Prepare Epicenter for public launch on Twitter/HN by fixing the four P0 blockers: outdated workspace README, non-publishable npm packages, "not yet implemented" UI strings, and landing page conversion gaps.

## Motivation

### Current State

The codebase is feature-complete for a first public impression, but the surfaces people actually touch. README, npm install, landing page, app UI. Have gaps that will be called out immediately on HN.

Problems:

1. **Workspace README references dead API**: `createClient`, `withDefinition`, `upsert`, `createServer`, `providers/setupPersistence`: none exist anymore. Actual API is `createWorkspace`, `client.tables.<name>.set/get/update/delete`.
2. **npm packages aren't publishable**: `@epicenter/workspace` isn't on npm. CLI has `workspace:*` and `catalog:` deps that break externally. No changeset tooling.
3. **"Not yet implemented" in shipped UI**: `alert('Live recording not yet implemented')` in Whispering layout, `// TODO: Implement form submission` in landing waitlist form.
4. **Landing page won't convert HN visitors**: No quickstart code block, no FAQ, blog posts from Jan 2025 only.

### Desired State

- README matches the real API with working code examples
- `bun add @epicenter/workspace` works and the code in README runs
- No user-visible TODO/WIP strings
- Landing page has technical credibility (code snippets, FAQ)

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Versioning scope | All packages/ unified at 0.1.0 | Simplicity. One version, one release. `private: true` prevents npm publish for internal packages. |
| Version tooling | Changesets | Industry standard for Bun/pnpm monorepos. |
| CLI runtime | Bun-only | Matches the stack. `bin` points to `.ts` files. Document requirement. |
| Public packages | workspace, cli, sync, filesystem, skills, ui, svelte | UI and Svelte bindings enable ecosystem development. |
| Private packages | constants, ai, vault | No standalone value or not ready (vault at 0.0.0). |
| Apps versioning | Independent, via deploy mechanisms | Apps are `private: true`, deployed to CF/Tauri/Chrome. |
| Landing page framework | Keep Astro + Svelte islands | Already works, uses @epicenter/ui components. |

## Implementation Plan

### Phase 1: README Rewrite (P0-A)

- [ ] **1.1** Read `packages/workspace/src/index.ts` exports to inventory the real public API
- [ ] **1.2** Read key source files: `create-workspace.ts`, `create-table.ts`, `types.ts`, `actions.ts`
- [ ] **1.3** Rewrite README Quick Start with working `createWorkspace` + `defineTable` example
- [ ] **1.4** Update all table operation examples: `set`, `get`, `update`, `delete`, `getAll`, `observe`
- [ ] **1.5** Update extension examples to use `withExtension` pattern (not `providers` map)
- [ ] **1.6** Update action examples: `defineQuery`, `defineMutation` with current signatures
- [ ] **1.7** Remove references to `createClient`, `withDefinition`, `upsert`, `createServer`, `providers/setupPersistence`
- [ ] **1.8** Verify every code block compiles against current types

### Phase 2: npm Publish Readiness (P0-B)

- [ ] **2.1** Install and configure changesets: `bunx changeset init`
- [ ] **2.2** Set all package versions to `0.1.0`
- [ ] **2.3** Add `description`, `keywords`, `repository`, `homepage` to all publishable package.json files
- [ ] **2.4** Mark `constants`, `ai`, `vault` as `"private": true` (constants already is)
- [ ] **2.5** Remove `"private": true` from `ui` and `svelte` packages
- [ ] **2.6** Verify `workspace:*` deps resolve correctly for npm publish (changesets handles this)
- [ ] **2.7** Verify `catalog:` deps are replaced with actual versions at publish time
- [ ] **2.8** Add root `release` script: `"release": "changeset version && changeset publish"`
- [ ] **2.9** Test publish with `--dry-run`

### Phase 3: UI TODO Removal (P0-C)

- [ ] **3.1** Remove `alert('Live recording not yet implemented')` from `apps/whispering/src/routes/(app)/(config)/+layout.svelte:132`: either implement or remove the toggle entirely
- [ ] **3.2** Fix `WaitlistForm.svelte`: either wire to a real endpoint (Discord webhook, Resend, etc.) or remove the TODO and show a Discord join link instead
- [ ] **3.3** Remove `// TODO: Implement real extension detection` from `apps/whispering/src/lib/services/notifications/web.ts`

### Phase 4: Landing Page Improvements (P0-D)

- [ ] **4.1** Add quickstart code block section after hero (terminal-style `bun add` + minimal example)
- [ ] **4.2** Add FAQ section before footer (3-5 questions HN will ask: "How is this different from Obsidian?", "Is my data encrypted?", "Can I self-host?")
- [ ] **4.3** Add OG image meta tag to `BaseLayout.astro` (og:image is missing)
- [ ] **4.4** Update bottom CTA section: swap primary to GitHub, secondary to Discord (hero is already correct)

## Open Questions

1. **WaitlistForm: wire or remove?**
   - Options: (a) Wire to Discord webhook, (b) Wire to Resend/email list, (c) Replace with Discord invite button
   - **Recommendation**: (c) Replace with Discord invite. Simplest, no backend needed, matches existing CTA pattern.

2. **Live recording toggle: implement or hide?**
   - Options: (a) Implement live recording, (b) Hide the toggle, (c) Show as "coming soon" badge
   - **Recommendation**: (b) Hide the toggle. Don't ship half-baked features.

## Success Criteria

- [ ] `bun add @epicenter/workspace` works (package exists on npm)
- [ ] README Quick Start code compiles and runs without errors
- [ ] No `alert()` with "not implemented" in any shipped UI
- [ ] Landing page has a code snippet section visible within first scroll
- [ ] `bunx changeset version` and `bunx changeset publish --dry-run` succeed

## References

- `packages/workspace/README.md`: Primary rewrite target
- `packages/workspace/src/index.ts`: Source of truth for public API
- `packages/workspace/src/workspace/create-workspace.ts`: Builder pattern implementation
- `packages/workspace/src/workspace/create-table.ts`: Table operations
- `packages/workspace/src/workspace/types.ts`: Type definitions
- `packages/workspace/package.json`: Exports map and metadata
- `packages/cli/package.json`: CLI metadata and bin field
- `apps/landing/src/pages/index.astro`: Landing page homepage
- `apps/landing/src/layouts/BaseLayout.astro`: Meta tags
- `apps/landing/src/components/WaitlistForm.svelte`: Broken form
- `apps/whispering/src/routes/(app)/(config)/+layout.svelte`: "Not implemented" alert
