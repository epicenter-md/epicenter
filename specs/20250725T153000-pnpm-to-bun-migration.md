# PNPM to Bun MonoRepo Migration Plan

## Overview
This document outlines the comprehensive plan to migrate the Whispering project from PNPM workspaces to Bun workspaces while maintaining the existing folder structure (`apps/*` and `packages/*`).

## Current State Analysis

### Workspace Structure
- **Apps**: app, auth, cli, sh, sh-proxy
- **Packages**: config, constants, shared, svelte-utils, ui
- **Build Tool**: Turborepo
- **Package Manager**: PNPM v10.11.0
- **Bun Version**: Already installed

### PNPM-Specific Files
- `pnpm-workspace.yaml`: Defines workspace locations
- `pnpm-lock.yaml`: Lockfile
- `.npmrc`: Contains `auto-install-peers = true`
- Scripts using `pnpm` commands

## Migration Benefits

1. **Performance**: Bun installs are significantly faster than PNPM, especially for large monorepos
2. **Built-in Runtime**: Bun is both a package manager and runtime, reducing toolchain complexity
3. **Native TypeScript Support**: Direct TypeScript execution without transpilation
4. **Simplified Tooling**: Fewer dependencies for common tasks
5. **Catalogs**: Centralized dependency version management

## Migration Steps

### 1. Create Migration Branch
```bash
# Ensure you're on main and up to date
git checkout main
git pull origin main

# Create a new feature branch for the migration
git checkout -b feat/migrate-to-bun-monorepo

# This branch will contain all migration changes and be merged via PR
```

### 2. Update Root package.json with Catalogs
Add the `workspaces` field with catalogs to your root `package.json`:

```json
{
  "name": "whispering",
  "private": true,
  "version": "7.1.1",
  "workspaces": {
    "packages": ["apps/*", "packages/*"],
    "catalogs": {
      "default": {
        "@types/node": "^22.15.32",
        "typescript": "^5.8.3",
        "eslint": "^9.30.1",
        "prettier": "^3.6.2",
        "svelte": "^5.35.5",
        "tailwindcss": "^4.1.11",
        "clsx": "^2.1.1",
        "tailwind-merge": "^3.3.1",
        "tailwind-variants": "^1.0.0",
        "bits-ui": "2.8.10",
        "mode-watcher": "^1.0.8",
        "svelte-sonner": "^1.0.5",
        "@lucide/svelte": "^0.525.0",
        "@tanstack/svelte-table": "9.0.0-alpha.10",
        "arktype": "^2.1.20",
        "zod": "^3.25.67"
      }
    }
  },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "format": "concurrently \"biome format --write .\" \"turbo run format\"",
    "lint": "concurrently \"biome lint --write --unsafe .\" \"turbo run lint\"",
    "format-and-lint": "concurrently \"bun run format\" \"bun run lint\"",
    "bump-version": "bun run scripts/bump-version.ts"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "@types/node": "catalog:",
    "concurrently": "latest",
    "turbo": "latest"
  }
}
```

### 3. Update Package Dependencies to Use Catalogs
Update workspace packages to reference catalog versions. For example, in `packages/ui/package.json`:

```json
{
  "devDependencies": {
    "@types/node": "catalog:",
    "eslint": "catalog:",
    "prettier": "catalog:",
    "svelte": "catalog:",
    "tailwindcss": "catalog:",
    "typescript": "catalog:"
  },
  "dependencies": {
    "bits-ui": "catalog:",
    "clsx": "catalog:",
    "@lucide/svelte": "catalog:",
    "mode-watcher": "catalog:",
    "svelte-sonner": "catalog:",
    "@tanstack/svelte-table": "catalog:",
    "tailwind-merge": "catalog:",
    "tailwind-variants": "catalog:"
  }
}
```

### 4. Remove PNPM-Specific Files
```bash
# Remove PNPM workspace configuration
rm pnpm-workspace.yaml

# Remove PNPM lockfile
rm pnpm-lock.yaml

# Update .npmrc (Bun supports auto-install-peers by default)
# Keep the file if you have other configurations, otherwise remove it
```

### 5. Update Package Scripts
Replace all `pnpm` references with `bun` in all `package.json` files:

```bash
# Find all package.json files with pnpm references
grep -r "pnpm" --include="package.json" .

# Update scripts in each package.json
# Example: "dev": "pnpm tauri dev" → "dev": "bun tauri dev"
```

### 6. Install Dependencies with Bun
```bash
# Clean install from root
bun install

# This will:
# - Read workspace configuration from package.json
# - Install all dependencies for all workspaces
# - Generate bun.lockb (binary lockfile)
```

### 7. Configure Bun (Optional)
Create a `bunfig.toml` in the root if you need specific configurations:

```toml
# bunfig.toml
[install]
# Optional: Set a specific registry
# registry = "https://registry.npmjs.org"

# Optional: Configure scopes
# "@mycompany" = { token = "$NPM_TOKEN" }

[install.cache]
# Optional: Configure cache directory
# dir = "~/.bun/install/cache"

[test]
# Optional: Configure test settings
# timeout = 60000
```

### 8. Update Turborepo Configuration
No changes needed to `turbo.json` as Turborepo works with Bun out of the box.

### 9. Handle Special Cases

#### Ignored Built Dependencies
The `ignoredBuiltDependencies` and `onlyBuiltDependencies` from `pnpm-workspace.yaml` need different handling in Bun:

```bash
# Create .bunfig.toml if needed for native dependencies
# Bun handles native dependencies better than PNPM, so these may not be needed
```

#### Workspace Protocol
The `workspace:*` protocol works the same in Bun, so no changes needed for inter-package dependencies.


### 10. Update CI/CD

#### GitHub Actions

##### publish-tauri-releases.yml
Update the workflow to use Bun instead of PNPM:

```yaml
# Remove pnpm installation step
- name: install pnpm
  uses: pnpm/action-setup@v4
  with:
    version: 10.11.0

# Replace with Bun installation
- name: setup bun
  uses: oven-sh/setup-bun@v2
  with:
    bun-version: latest

# Update Node.js setup to remove pnpm cache
- name: setup node
  uses: actions/setup-node@v4
  with:
    node-version: lts/*
    # Remove: cache: 'pnpm'

# Update install command
- name: install frontend dependencies
  run: bun install  # was: pnpm install

# Update build command
- name: Build Tauri App
  uses: tauri-apps/tauri-action@v0
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  with:
    args: ${{ matrix.args }}
    # Update beforeBuildCommand
    beforeBuildCommand: |
      bun --filter @epicenter/app build  # was: pnpm --filter @epicenter/app build
```

##### Other Workflow Files
For any other workflow files that use package managers:

1. **Replace pnpm action**:
   ```yaml
   # Before
   - uses: pnpm/action-setup@v4
   
   # After
   - uses: oven-sh/setup-bun@v2
   ```

2. **Update commands**:
   - `pnpm install` → `bun install`
   - `pnpm run` → `bun run`
   - `pnpm --filter` → `bun --filter`

3. **Remove pnpm caching**:
   ```yaml
   # Remove from Node.js setup
   cache: 'pnpm'
   ```

#### Local Development Scripts
Update any scripts in the repository that reference pnpm:

```bash
# Find all references to pnpm in scripts
grep -r "pnpm" scripts/ --include="*.ts" --include="*.js" --include="*.sh"
```

### 11. Testing & Verification

```bash
# Test installation
bun install

# Test development servers
bun run dev

# Test builds
bun run build

# Test individual app
cd apps/whispering
bun run dev

# Test Turborepo integration
bun run build --filter=@epicenter/app
```

### 12. Commit Changes

```bash
# Add all changes
git add .

# Commit with descriptive message
git commit -m "feat: migrate from PNPM to Bun monorepo with catalogs

- Replace PNPM with Bun package manager
- Implement Bun catalogs for shared dependency management
- Update all package.json files to use catalog references
- Update CI/CD workflows to use Bun
- Remove PNPM-specific configuration files
- Update scripts to use Bun commands

BREAKING CHANGE: Developers need to install Bun instead of PNPM"

# Push to remote
git push origin feat/migrate-to-bun-monorepo
```

### 13. Create Pull Request

```bash
# Use GitHub CLI to create PR
gh pr create \
  --title "feat: migrate from PNPM to Bun monorepo" \
  --body "$(cat <<'EOF'
## Summary
- Migrated from PNPM to Bun for improved performance and simpler toolchain
- Implemented Bun catalogs for centralized dependency management
- Updated all CI/CD workflows

## Changes
- ✅ Updated root package.json with workspaces and catalogs configuration
- ✅ Migrated all workspace packages to use catalog references
- ✅ Removed PNPM-specific files (pnpm-workspace.yaml, pnpm-lock.yaml)
- ✅ Updated all scripts from `pnpm` to `bun` commands
- ✅ Updated GitHub Actions workflows to use Bun
- ✅ Tested all development and build processes

## Breaking Changes
Developers will need to install Bun instead of PNPM:
```bash
curl -fsSL https://bun.sh/install | bash
```

## Testing
- [x] All dependencies install correctly
- [x] Development servers start without errors
- [x] Production builds complete successfully
- [x] Turborepo commands work correctly
- [x] CI/CD pipelines pass

## Migration Guide
See `docs/specs/20250725T153000-pnpm-to-bun-migration.md` for detailed migration information.
EOF
)"
```

### 14. Post-Migration Cleanup

After the PR is merged:

1. Update documentation
2. Update README.md installation instructions
3. Update contributor guidelines
4. Notify team members about the change
5. Monitor for any issues in the first few days

## Potential Issues & Solutions

### Issue 1: Binary Dependencies
Some packages with native bindings might behave differently.
**Solution**: Bun generally handles these better than PNPM, but test thoroughly.

### Issue 2: Lockfile in Git
Bun uses a binary lockfile (`bun.lockb`).
**Solution**: Add to `.gitattributes`:
```
bun.lockb binary diff=lockb
```

### Issue 3: Script Compatibility
Some npm scripts might need adjustment.
**Solution**: Bun is largely npm-compatible, but test all scripts.

### Issue 4: Turborepo Warnings
May see warnings about Bun's lockfile format.
**Solution**: Update Turborepo to latest version which has better Bun support.

## Rollback Plan

If issues arise:
```bash
# Restore PNPM files
git checkout main -- pnpm-workspace.yaml pnpm-lock.yaml
git checkout main -- "**/package.json"

# Reinstall with PNPM
pnpm install
```

## Additional Bun-Specific Features

### 1. Bun Scripts
Leverage Bun's built-in features in scripts:

```json
{
  "scripts": {
    // Bun runs TypeScript directly
    "bump-version": "bun scripts/bump-version.ts",
    
    // Use bun's built-in test runner
    "test": "bun test",
    
    // Bun's built-in bundler
    "bundle": "bun build ./src/index.ts --outdir ./dist"
  }
}
```

### 2. Environment Variables
Bun automatically loads `.env` files:
- `.env.local` (highest priority)
- `.env.development` / `.env.production`
- `.env`

### 3. Built-in APIs
Replace Node.js polyfills with Bun's native APIs:
```typescript
// File operations
const file = Bun.file("./package.json");
const pkg = await file.json();

// HTTP server
Bun.serve({
  port: 3000,
  fetch(req) {
    return new Response("Hello from Bun!");
  },
});
```

## Success Criteria

- [ ] All dependencies install correctly with catalog references
- [ ] Development servers start without errors
- [ ] Production builds complete successfully
- [ ] All tests pass
- [ ] Turborepo commands work correctly
- [ ] CI/CD pipelines pass with Bun
- [ ] Catalog versions are properly resolved
- [ ] No regression in development experience

## Timeline

1. **Preparation** (15 min): Backup branch
2. **Configuration** (1.5 hours): Update package.json files with catalogs
3. **Migration** (30 min): Remove PNPM files, run Bun install
4. **CI/CD Updates** (1 hour): Update all workflows
5. **Testing** (2 hours): Verify all functionality
6. **Documentation** (1 hour): Update all docs

Total estimated time: 6 hours

## Next Steps

1. Review this plan with the team
2. Schedule migration during low-activity period
3. Ensure all team members have Bun installed
4. Execute migration following this plan
5. Monitor for issues in the following days

## Resources

- [Bun Workspaces Documentation](https://bun.sh/docs/install/workspaces)
- [Bun Catalogs](https://bun.com/docs/install/catalogs)
- [Turborepo with Bun](https://turborepo.com/blog/turbo-2-5)
- [Migration Examples](https://github.com/barmiedev/turbobun)