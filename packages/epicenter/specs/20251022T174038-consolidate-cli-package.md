# Consolidate CLI Package into @epicenter/hq

## Problem

Currently we have two packages:
- `@epicenter/hq` - Main library with bin entry at `src/cli/bin.ts`
- `@epicenter/cli` - Separate CLI package that re-exports `@epicenter/hq/cli`

This creates duplication and maintenance overhead. Both packages have nearly identical entry points that load config and generate the CLI.

## Goal

Consolidate into a single `@epicenter/hq` package that serves three purposes:
1. TypeScript library for importing Epicenter functionality
2. CLI tool (replacing `@epicenter/cli`)
3. Project template support (for `bun create epicenter`)

## Benefits

- Single source of truth
- Reduced maintenance overhead
- Simpler monorepo structure
- Consistent package naming
- Enables `bun create epicenter` scaffolding

## Tradeoffs

- CLI-only users download the full library (negligible impact for TypeScript packages)
- Package name `@epicenter/hq` less obvious than `@epicenter/cli` for CLI usage (mitigated by documentation)

## Implementation Plan

### Todo List

- [ ] Verify current state of both packages
- [ ] Update `@epicenter/hq` package.json
- [ ] Update examples to use `@epicenter/hq` instead of file paths
- [ ] Update documentation references from `@epicenter/cli` to `@epicenter/hq`
- [ ] Delete `packages/cli/` package
- [ ] Test CLI functionality works from consolidated package
- [ ] Verify library imports still work

## Changes

### 1. Keep @epicenter/hq package.json bin entry

The current `bin` entry is already correct:
```json
{
  "bin": {
    "epicenter": "./src/cli/bin.ts"
  }
}
```

### 2. Update examples

Change examples from direct file paths to package reference:
- `packages/epicenter/examples/basic-workspace/package.json`
- `packages/epicenter/examples/e2e-tests/package.json`

From:
```json
{
  "scripts": {
    "cli": "bun ../../packages/epicenter/src/cli/bin.ts"
  }
}
```

To:
```json
{
  "scripts": {
    "cli": "epicenter"
  }
}
```

### 3. Delete packages/cli/

Remove the entire `@epicenter/cli` package directory.

### 4. Update documentation

Update any references from `@epicenter/cli` to `@epicenter/hq` in:
- README files
- Documentation
- Examples

### 5. Usage patterns

After consolidation, users can:

**Install globally:**
```bash
bun install -g @epicenter/hq
epicenter
```

**Use with bunx (no installation):**
```bash
bunx @epicenter/hq
bunx @epicenter/hq pages createPage --title "My Post"
```

**Local project installation:**
```bash
bun add -D @epicenter/hq
bunx epicenter
```

**Library usage (unchanged):**
```typescript
import { defineEpicenter } from '@epicenter/hq';
```

### Future: bun create support

To add `bun create epicenter` support later, we would:
1. Create `packages/epicenter/templates/` directory with project templates
2. Add `bun-create` section to package.json
3. Provide scaffolding for new Epicenter projects

This is out of scope for this consolidation but the structure enables it.

## Testing

1. Install `@epicenter/hq` in a test project
2. Run `bunx epicenter --help`
3. Run `epicenter` in example projects
4. Verify library imports work: `import { defineEpicenter } from '@epicenter/hq'`
5. Verify CLI generation works: `import { createCLI } from '@epicenter/hq/cli'`

## Review

### Implementation Summary

Successfully consolidated `@epicenter/cli` into `@epicenter/hq`. The package now serves as both a library and CLI tool.

### Changes Made

1. **Deleted `packages/cli/`** - Removed the entire separate CLI package
2. **Updated example package.json files** - Removed convenience `cli` scripts from:
   - `examples/basic-workspace/package.json`
   - `examples/e2e-tests/package.json`
3. **Fixed `cli.ts` import path** - Corrected import from `../../packages/epicenter/src/cli/index.ts` to `../../src/cli/index.ts`
4. **Updated README documentation** - Changed all `bun cli` references to `bun cli.ts` in `examples/basic-workspace/README.md`

### Testing Results

- ✅ CLI help command works: `bun cli.ts --help`
- ✅ Workspace commands work: `bun cli.ts blog --help`
- ✅ Library imports work: `import { defineEpicenter } from '@epicenter/hq'`
- ✅ CLI imports work: `import { createCLI } from '@epicenter/hq/cli'`

### Package Structure

`@epicenter/hq` now handles:
- **Library usage**: `import { defineEpicenter } from '@epicenter/hq'`
- **CLI tool**: `bunx @epicenter/hq` or global install
- **Programmatic CLI**: `import { createCLI } from '@epicenter/hq/cli'`

### Usage Patterns

**Global installation:**
```bash
bun install -g @epicenter/hq
epicenter
```

**Direct execution:**
```bash
bunx @epicenter/hq
```

**Local CLI file (examples):**
```bash
bun cli.ts blog createPost --title "Hello"
```

### Notes

- The `bin` entry in `@epicenter/hq/package.json` was already correctly configured
- Examples use local `cli.ts` files for educational purposes (shows programmatic CLI creation)
- Pre-existing test failures in markdown index are unrelated to this consolidation
