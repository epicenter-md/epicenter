# Fix IntelliSense for core Client types

## Goals
- Improve TypeScript IntelliSense for the core client types by:
  - Converting `interface` to `type` (repo convention)
  - Providing sensible default generics for `Client` so methods aren’t `never`
  - Keep changes minimal and non-breaking for current usage

## Scope
- Target file mapped from request path to actual repo path:
  - Requested: `packages/epicenter/src/core/types.ts`
  - Actual: `apps/sh/src/lib/client/core/types.ts`

## TODO
- [x] Convert `export interface Client` to `export type Client` with same shape
- [x] Add safe default generics instead of `never` to improve IntelliSense
- [x] Convert `export interface Config` to `export type Config`
- [x] Ensure downstream types still line up (no API changes)
- [ ] Run a quick type check for `apps/sh`

## Out of Scope
- Broader refactors or style unification in other files
- Changing public API shapes or behavior

## Review
- Summary
  - Replaced interfaces with type aliases in `apps/sh/src/lib/client/core/types.ts` per code style.
  - Added editor-friendly default generics for `Client` (`AnyRequestFn`, `AnyMethodFn`, `AnyBuildUrlFn`) so IntelliSense shows method signatures even when generics aren’t specialized.
  - No API surface changes for consumers that already specialize generics (e.g., `apps/sh/src/lib/client/client/types.ts`).
- Trade-offs / Notes
  - Defaults are intentionally broad (`any`-based) to aid IntelliSense; downstream code should continue specializing generics to retain strong types.
  - Skipped running `apps/sh` type check locally due to missing toolchain. Recommend running `bun i && bun run -C apps/sh check` in dev environment.
