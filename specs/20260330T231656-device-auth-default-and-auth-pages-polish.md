# Device Auth Default and Auth Pages Polish

**Date**: 2026-03-30
**Status**: Draft
**Author**: OpenCode

## Overview

Flip the CLI so `epicenter auth login` defaults to the browser/device flow, keep password login available only behind an explicit flag, and do a small visual polish pass on the hosted auth pages in `apps/api` so they feel less default and more intentional.

## Motivation

### Current State

The CLI still assumes terminal-first credential entry.

- `packages/cli/src/commands/auth-command.ts` treats password login as the default when stdin is a TTY.
- The branching today is effectively:

```typescript
if (argv.device || !process.stdin.isTTY) {
	await loginWithDeviceCode(serverUrl, home);
	return;
}

// password flow
const email = await readLine('Email: ');
const password = await readLine('Password: ', true);
```

The hosted auth UI in `apps/api` already exists, but it is visually conservative.

- `apps/api/src/auth-pages/layout.tsx` provides a shared auth shell.
- `apps/api/src/auth-pages/styles.ts` defines the entire auth-page look with inline CSS.
- `apps/api/src/auth-pages/sign-in-page.tsx`, `device-page.tsx`, and `consent-page.tsx` render the actual user-facing auth screens.

This creates problems:

1. **Wrong CLI default**: The browser/device flow is the better default for modern auth, but users get email/password prompts instead.
2. **Too-easy password fallback**: Terminal password entry stays on the happy path even though it should be the explicit escape hatch.
3. **Auth UI feels plain**: The hosted auth pages work, but the typography and layout do not feel as deliberate as the rest of the product.

### Desired State

The CLI should behave like this:

```bash
epicenter auth login --server https://api.epicenter.so
# opens device/browser flow by default

epicenter auth login --server https://api.epicenter.so --password
# explicitly opts into terminal email/password prompts
```

And the hosted auth pages should keep their current structure while getting a small, low-risk typography/layout improvement.

## Research Findings

### CLI auth flow

| Topic | Finding | Source |
| --- | --- | --- |
| Auth command entry | Login flow selection happens in one file | `packages/cli/src/commands/auth-command.ts` |
| Device flow | Already implemented and complete | `packages/cli/src/auth/device-flow.ts` |
| Password flow | Already implemented and complete | `packages/cli/src/auth/api.ts`, `packages/cli/src/commands/auth-command.ts` |
| Current default | Password is default on TTY; device only on `--device` or non-TTY | `packages/cli/src/commands/auth-command.ts` |
| Test surface | No obvious dedicated CLI auth tests surfaced in this pass | repo search |

**Key finding**: The behavior change is mostly one-file work. We do not need to redesign auth. Just flip the branching and change the flag surface.

### Hosted auth UI in `apps/api`

| Topic | Finding | Source |
| --- | --- | --- |
| Shared shell | All auth pages go through a single layout | `apps/api/src/auth-pages/layout.tsx` |
| Shared styling | Typography, spacing, inputs, cards, buttons all come from one inline CSS string | `apps/api/src/auth-pages/styles.ts` |
| Screens | Sign-in, consent, device, and signed-in pages are separate TSX files | `apps/api/src/auth-pages/*.tsx` |
| Route wiring | `/sign-in`, `/consent`, `/device` are rendered from `app.ts` | `apps/api/src/app.ts` |
| Font choice | Standalone auth pages intentionally use a system-ui stack; brand font is not loaded | `apps/api/src/auth-pages/styles.ts` comment |

**Key finding**: The visual polish surface is also small. Most visual improvement can happen in `apps/api/src/auth-pages/styles.ts` without restructuring routes or page components.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| CLI default auth flow | Device flow becomes the default | Better UX; aligns with browser-based auth and avoids password entry in terminals |
| Password auth | Keep it, but behind `--password` | Useful as an escape hatch without keeping it on the main path |
| `--device` flag | Remove or stop documenting it as primary | It becomes redundant once device is the default |
| API auth-page scope | Polish existing auth pages, not a redesign | Smallest change with visible payoff |
| UI change surface | Start in `apps/api/src/auth-pages/styles.ts` | Centralized visual control with low implementation risk |

## Architecture

```text
CLI login
---------
epicenter auth login
  -> auth-command.ts
     -> default path: loginWithDeviceCode()
     -> explicit escape hatch: --password -> signInWithEmail()
```

```text
Hosted auth UI
--------------
app.ts routes
  -> auth-pages/index.tsx renderers
  -> AuthLayout in layout.tsx
  -> AUTH_STYLES in styles.ts
  -> page-specific TSX + scripts
```

## Implementation Plan

### Phase 1: Flip the CLI auth default

- [ ] **1.1** Update `packages/cli/src/commands/auth-command.ts` so `epicenter auth login` defaults to device flow.
- [ ] **1.2** Replace the current `--device`-driven branch with an explicit `--password` path for terminal credential entry.
- [ ] **1.3** Update the command descriptions and top-of-file JSDoc in `packages/cli/src/commands/auth-command.ts` so the documented behavior matches reality.

### Phase 2: Polish hosted auth pages

- [ ] **2.1** Review `apps/api/src/auth-pages/styles.ts` and make a small typography/layout improvement that keeps the existing auth-page structure intact.
- [ ] **2.2** If needed, make minimal companion markup tweaks in `apps/api/src/auth-pages/layout.tsx` or the page TSX files only where the style change needs semantic support.
- [ ] **2.3** Verify that `/sign-in`, `/consent`, and `/device` still render correctly under the shared auth shell.

### Phase 3: Verify and document

- [ ] **3.1** Run diagnostics/typecheck for the changed TypeScript files.
- [ ] **3.2** Manually verify CLI help text and auth-page rendering behavior after the changes.
- [ ] **3.3** Add a review section to this spec after implementation with what changed and any follow-up notes.

## Edge Cases

### Non-interactive CLI environments

1. A script runs `epicenter auth login` without a TTY.
2. Device flow should still be the default.
3. The command should not regress into trying to prompt for credentials.

### Users who still want terminal passwords

1. A developer or local operator prefers entering email and password directly.
2. They use `--password` explicitly.
3. Existing password flow should still work exactly as before.

### Auth-page polish overreach

1. A style tweak starts to become a redesign.
2. The change spills into multiple page components or introduces new assets.
3. Stop and keep the pass small; the goal is polish, not a theme rewrite.

## Open Questions

1. **Should `--device` stay as a compatibility alias after device becomes the default?**
   - Options: (a) remove it now, (b) keep it as a no-op alias, (c) keep it temporarily and deprecate later
   - **Recommendation**: Keep it temporarily as a harmless alias if that is easy; otherwise remove it. The flag becomes semantically pointless once device is the default.

2. **How far should the auth-page polish go in this pass?**
   - Options: (a) one-file style polish only, (b) style polish plus tiny layout tweaks, (c) broader auth-page redesign
   - **Recommendation**: Do (a) or light (b). Anything broader is a separate task.

## Success Criteria

- [ ] Running `epicenter auth login --server ...` uses device flow by default.
- [ ] Running `epicenter auth login --server ... --password` still supports email/password login.
- [ ] CLI help text and command descriptions reflect the new default.
- [ ] Hosted auth pages in `apps/api` look more deliberate without changing their route structure or auth behavior.
- [ ] Typecheck/diagnostics are clean for changed files.

## References

- `packages/cli/src/commands/auth-command.ts` - CLI auth branching and flag definitions
- `packages/cli/src/auth/device-flow.ts` - device-code login implementation
- `packages/cli/src/auth/api.ts` - password login API call surface
- `apps/api/src/app.ts` - auth-page route wiring
- `apps/api/src/auth-pages/index.tsx` - auth-page render entrypoints
- `apps/api/src/auth-pages/layout.tsx` - shared auth-page shell
- `apps/api/src/auth-pages/styles.ts` - centralized inline auth-page styling
- `apps/api/src/auth-pages/sign-in-page.tsx` - sign-in UI
- `apps/api/src/auth-pages/device-page.tsx` - device approval UI
- `apps/api/src/auth-pages/consent-page.tsx` - consent UI
