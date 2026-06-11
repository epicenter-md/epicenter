---
name: monorepo
description: 'Monorepo scripts, package boilerplate, conventions. Use when: "how do I run", "bun run", "build this", "run tests", "typecheck", "create a new package", linting, scaffolding packages.'
metadata:
  author: epicenter
  version: '2.0'
---

# Script Commands

## Reference Repositories

- [jsrepo](https://github.com/jsrepojs/jsrepo) : Package distribution for monorepos
- [WXT](https://github.com/wxt-dev/wxt) : Browser extension framework (used by tab-manager app)

## Upstream Grounding

When jsrepo configuration, publish behavior, block layout, or package distribution affects correctness, use source-backed grounding before relying on memory. If DeepWiki MCP is available, ask a narrow question against `jsrepojs/jsrepo`; for browser-extension build behavior, prefer the `wxt` skill, or ask against `wxt-dev/wxt` if this skill owns the script or package boundary. If DeepWiki is unavailable or the repo is not indexed, use upstream source or official docs directly. Treat DeepWiki as orientation, then verify decisive details against local package scripts, config files, installed types, generated output, or official docs before changing code.

Skip DeepWiki for repo-local Bun script conventions already documented below.

The monorepo uses consistent script naming conventions:

## When to Apply This Skill

Use this pattern when you need to:

- Run formatting, linting, or type-check scripts in this monorepo.
- Choose between auto-fix commands and `:check` CI-only variants.
- Verify final changes with the repo-standard `bun typecheck` workflow.
- Scaffold a new package in `packages/`.

| Command            | Purpose                                        | When to use |
| ------------------ | ---------------------------------------------- | ----------- |
| `bun format`       | **Fix** formatting (biome)                     | Development |
| `bun format:check` | Check formatting                               | CI          |
| `bun lint`         | **Fix** lint issues (biome)                    | Development |
| `bun lint:check`   | Check lint issues                              | CI          |
| `bun typecheck`    | Type checking (tsc, svelte-check, astro check) | Both        |
| `bun test`         | Run unit tests (`*.test.ts` only)              | Both        |
| `bun bench`        | Run benchmarks (`*.bench.ts`; reports, no assertions) | Manual |

## Convention

- No suffix = **fix** (modifies files)
- `:check` suffix = check only (for CI, no modifications)
- `typecheck` alone = type checking (separate concern, cannot auto-fix)
- `test` runs only `*.test.ts`; `bench` runs only `*.bench.ts`. A file is
  one or the other : never both. Benchmarks print reports; tests assert.

## Dev Scripts

Apps use either a single `dev` script (when there is only one sensible local
workflow) or a `dev:local` alias (kept for symmetry with `:remote` db scripts).
The suffix convention applies primarily to database commands:

| Script | Meaning |
| --- | --- |
| `dev` | The default local workflow. May still require Infisical login for app secrets (e.g. API keys), but only ever talks to local infrastructure at runtime. |
| `dev:local` | Used when an app keeps the `dev` -> `dev:local` alias for explicit naming. Equivalent to `dev`. |
| `db:*:local` | Runs against local Postgres. Works without Infisical login. |
| `db:*:remote` | Wraps with `infisical run --env=prod`. Production data; treat as admin. |

There is no `dev:remote`. Production data is reached only through `:remote` db
scripts and `deploy`, never through a development server.

## CLI (`epicenter`)

From the monorepo root, `bun epicenter` runs the local CLI against `localhost:8787`:

```bash
bun epicenter start playground/opensidian-e2e --verbose
bun epicenter list files -C playground/opensidian-e2e
```

The bare `epicenter` command (global install) defaults to `api.epicenter.so`.
Config files read `process.env.EPICENTER_SERVER` with a prod fallback:the root
script sets it automatically.

## After Completing Code Changes

Run type checking to verify:

```bash
bun typecheck
```

This runs `bun run --filter '*' typecheck` which executes the `typecheck` script in each package (e.g., `tsc --noEmit`, `svelte-check`).

## New Package Boilerplate

When creating a new package in `packages/`, follow this exact structure.

### `package.json`

```json
{
  "name": "@epicenter/<package-name>",
  "version": "0.0.1",
  "exports": {
    ".": "./src/index.ts"
  },
  "license": "MIT",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {},
  "devDependencies": {
    "@types/bun": "catalog:",
    "typescript": "catalog:"
  }
}
```

Key conventions:

- `exports` only, no `main`/`types`: modern resolvers ignore `main`/`types` when `exports` is present. The entry point is `./src/index.ts`; there is no build step, consumers import the source directly.
- Use `"workspace:*"` for internal deps (e.g., `"@epicenter/workspace": "workspace:*"`).
- Use `"catalog:"` for shared versions managed in the root `package.json` catalogs.
- `peerDependencies` for packages consumers must also install (e.g., `yjs`).

### `tsconfig.json`

A leaf config picks a tier and adds nothing that repeats a base. For a Bun library:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["bun"],
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

A Svelte or browser library extends `../../tsconfig.dom.json` instead. For all eight leaf tiers, the never-redeclare list, and the module strategy, see the `tsconfig` skill.

After creating the package, run `bun install` from the repo root to register it in the workspace.
