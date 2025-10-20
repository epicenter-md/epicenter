# Fix Type IntelliSense for Core Types

## Problem
Type IntelliSense consumers report missing or incorrect definitions from the core types module under `packages/epicenter/src/core/types.ts`. We need to inspect the current type exports, understand why editors cannot surface the expected types, and adjust the module so it provides accurate symbols while following our type alias conventions.

## Plan

### Todo Items
- [ ] Locate `packages/epicenter/src/core/types.ts` (or its new location) and document the current exports and how consumers import them today.
- [ ] Reproduce or reason through the IntelliSense failure, identify the root cause (e.g., missing `type` exports, incorrect re-exports, or config issues), and choose the minimal change to resolve it.
- [ ] Implement the TypeScript fixes, ensuring we rely on `type` aliases (no interfaces), adjust any imports to required absolute paths, and keep helpers inlined per our patterns.
- [ ] Validate the updated types by running (or dry-running) a targeted TypeScript check / editor simulation, or outline manual verification steps if automated tooling is impractical.
- [ ] Update this plan with a review section summarizing the changes once complete.

## Open Questions / Risks
- The target file path might have been relocated during recent refactors; we need to confirm its current location before editing.
- Depending on the scope, repo-wide type checks may be slow; we may opt for focused validation to avoid unnecessary cost.

## Review
_To be completed after implementation._
