---
name: monorepo
description: Monorepo script commands and conventions for this codebase. Use when running builds, tests, formatting, linting, or type checking.
---

# Script Commands

The monorepo uses consistent script naming conventions:

| Command            | Purpose                                        | When to use |
| ------------------ | ---------------------------------------------- | ----------- |
| `bun format`       | **Fix** formatting (biome + prettier)          | Development |
| `bun format:check` | Check formatting                               | CI          |
| `bun lint`         | **Fix** lint issues (eslint + biome)           | Development |
| `bun lint:check`   | Check lint issues                              | CI          |
| `bun typecheck`    | Type checking (tsc, svelte-check, astro check) | Both        |

## Convention

- No suffix = **fix** (modifies files)
- `:check` suffix = check only (for CI, no modifications)
- `typecheck` alone = type checking (separate concern, cannot auto-fix)

## After Completing Code Changes

Run type checking to verify:

```bash
bun typecheck
```

This runs `turbo run typecheck` which executes the `typecheck` script in each package (e.g., `tsc --noEmit`, `svelte-check`).
