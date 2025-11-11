# Cloudflare Workers Migration & PR Preview Setup

## Overview

Migrate the Whispering app from Cloudflare Pages to Cloudflare Workers and set up automatic preview deployments for pull requests. This migration provides access to Workers-exclusive features and a more unified deployment platform.

## Current State Analysis

### Deployment Setup
- **Current deployment**: Cloudflare Pages via `wrangler pages deploy`
- **Adapter**: `@sveltejs/adapter-static` with SPA fallback (`index.html`)
- **Build output**: Static assets in `apps/whispering/dist/`
- **Deploy command**: `bun run build && wrangler pages deploy`
- **CI/CD**: GitHub Actions workflow deploys to Pages on push to main

### Key Observations
1. **This is a SPA (Single Page Application)**: Uses `adapter-static` with fallback, meaning all assets are prerendered
2. **No SSR**: No server-side rendering, which simplifies the Workers migration
3. **Static assets only**: The build output is purely client-side HTML/JS/CSS
4. **Existing workflow**: Already has sophisticated CI/CD with validation, artifact uploads, and deployment

## Migration Strategy

Since this is a static SPA, the migration is straightforward:
- Static assets can be served directly from Workers Static Assets
- No need for `adapter-cloudflare` (which is for SSR)
- Keep using `adapter-static` as-is
- Only change deployment target from Pages to Workers

## Implementation Plan

### ✅ Todo Items

- [ ] Create `wrangler.toml` configuration for Workers deployment
- [ ] Update `apps/whispering/package.json` deploy script
- [ ] Update GitHub Actions workflow for Workers deployment
- [ ] Add PR preview deployment workflow
- [ ] Test local deployment with Workers
- [ ] Update documentation

## Detailed Implementation

### 1. Create `wrangler.toml`

Create `/Users/braden/Code/whispering/.conductor/columbia/apps/whispering/wrangler.toml`:

```toml
name = "whispering"
compatibility_date = "2025-01-01"

# Static assets configuration for SPA
[assets]
directory = "dist"
binding = "STATIC_ASSETS"

# Route configuration (will be set up via dashboard for custom domains)
routes = [
  { pattern = "*", zone_name = "your-domain.com" }
]

# Build configuration
[build]
command = "bun run build"
```

**Rationale**:
- `assets.directory = "dist"` points to the static build output from adapter-static
- `assets.binding = "STATIC_ASSETS"` exposes assets to the Worker
- No `main` worker script needed since this is purely static assets
- `compatibility_date` ensures we use latest Workers features

### 2. Update Deploy Script

Modify `apps/whispering/package.json`:

```json
{
  "scripts": {
    "deploy": "bun run build && wrangler deploy"
  }
}
```

**Change**: Replace `wrangler pages deploy` with `wrangler deploy`

### 3. Update GitHub Actions Workflow

Modify `.github/workflows/deploy-cloudflare.yml` for the `deploy-whispering` job:

**Key changes**:
1. Update deployment command from `wrangler pages deploy` to `wrangler deploy`
2. Remove Pages-specific flags (`--project-name`, `--branch`)
3. Add environment-based deployment logic (production vs preview)
4. Update URL extraction pattern

**New deployment step**:
```yaml
- name: Deploy to Cloudflare Workers
  id: deploy
  run: |
    cd apps/whispering

    # Deploy based on environment
    if [ "${{ github.event.inputs.environment }}" = "preview" ]; then
      # Preview deployments use versioned workers
      DEPLOYMENT_OUTPUT=$(bunx wrangler deploy \
        --name whispering-preview \
        --env preview 2>&1)
    else
      # Production deployment
      DEPLOYMENT_OUTPUT=$(bunx wrangler deploy 2>&1)
    fi

    echo "$DEPLOYMENT_OUTPUT"

    # Extract deployment URL
    DEPLOYMENT_URL=$(echo "$DEPLOYMENT_OUTPUT" | grep -oE 'https://[^\s]+' | head -1)

    if [ -z "$DEPLOYMENT_URL" ]; then
      DEPLOYMENT_URL="https://whispering.workers.dev"
    fi

    echo "deployment-url=$DEPLOYMENT_URL" >> $GITHUB_OUTPUT
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

### 4. Create PR Preview Workflow

Create `.github/workflows/preview-deployment.yml`:

```yaml
name: Preview Deployment

on:
  pull_request:
    types: [opened, synchronize, reopened]
    paths:
      - 'apps/whispering/**'
      - 'packages/**'
      - '.github/workflows/preview-deployment.yml'

concurrency:
  group: preview-${{ github.ref }}
  cancel-in-progress: true

env:
  NODE_VERSION: '22'
  BUN_VERSION: 'latest'

jobs:
  deploy-preview:
    name: Deploy Preview
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      deployments: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ env.BUN_VERSION }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'bun'

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build Whispering
        run: bun run --filter @repo/whispering build
        env:
          NODE_ENV: production

      - name: Deploy preview to Cloudflare Workers
        id: deploy
        run: |
          cd apps/whispering

          # Create unique preview name based on PR number
          PREVIEW_NAME="whispering-pr-${{ github.event.pull_request.number }}"

          DEPLOYMENT_OUTPUT=$(bunx wrangler deploy \
            --name "$PREVIEW_NAME" \
            --env preview 2>&1)

          echo "$DEPLOYMENT_OUTPUT"

          # Extract deployment URL
          DEPLOYMENT_URL=$(echo "$DEPLOYMENT_OUTPUT" | grep -oE 'https://[^\s]+' | head -1)

          if [ -z "$DEPLOYMENT_URL" ]; then
            DEPLOYMENT_URL="https://${PREVIEW_NAME}.workers.dev"
          fi

          echo "deployment-url=$DEPLOYMENT_URL" >> $GITHUB_OUTPUT
          echo "preview-name=$PREVIEW_NAME" >> $GITHUB_OUTPUT
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Comment on PR
        uses: actions/github-script@v7
        with:
          script: |
            const deploymentUrl = '${{ steps.deploy.outputs.deployment-url }}';
            const previewName = '${{ steps.deploy.outputs.preview-name }}';

            const comment = `## 🚀 Preview Deployment Ready!

            **Whispering Preview**: ${deploymentUrl}

            **Worker Name**: \`${previewName}\`

            This preview will be automatically updated with new commits to this PR.

            ---
            <sub>Built with commit ${context.sha}</sub>`;

            // Find existing comment
            const { data: comments } = await github.rest.issues.listComments({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
            });

            const botComment = comments.find(comment =>
              comment.user.type === 'Bot' &&
              comment.body.includes('Preview Deployment Ready')
            );

            if (botComment) {
              // Update existing comment
              await github.rest.issues.updateComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                comment_id: botComment.id,
                body: comment
              });
            } else {
              // Create new comment
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.issue.number,
                body: comment
              });
            }

      - name: Add deployment summary
        run: |
          echo "### 🚀 Preview Deployment" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "**Status:** ✅ Deployed successfully" >> $GITHUB_STEP_SUMMARY
          echo "**URL:** ${{ steps.deploy.outputs.deployment-url }}" >> $GITHUB_STEP_SUMMARY
          echo "**Worker:** \`${{ steps.deploy.outputs.preview-name }}\`" >> $GITHUB_STEP_SUMMARY
          echo "**PR:** #${{ github.event.pull_request.number }}" >> $GITHUB_STEP_SUMMARY
          echo "**Commit:** \`${{ github.sha }}\`" >> $GITHUB_STEP_SUMMARY
```

**Features**:
- Deploys a unique Worker per PR (`whispering-pr-123`)
- Updates existing PR comments instead of creating new ones
- Only triggers on changes to relevant files
- Cancels in-progress deployments for the same PR

### 5. Environment Configuration for wrangler.toml

Add environment-specific config to support preview deployments:

```toml
[env.preview]
name = "whispering-preview"
routes = []

[env.production]
name = "whispering"
```

## Migration Steps (Manual Checklist)

1. **Create wrangler.toml** in `apps/whispering/`
2. **Test local deployment**:
   ```bash
   cd apps/whispering
   bun run build
   wrangler deploy --dry-run
   ```
3. **Update package.json** deploy script
4. **Update GitHub Actions workflow** for Workers deployment
5. **Create PR preview workflow**
6. **Test with a PR** to verify preview deployments work
7. **Transfer domain settings** from Pages to Workers (via Cloudflare dashboard)
8. **Deploy to production** via updated workflow
9. **Verify production deployment** works correctly
10. **Delete old Pages project** (optional, after confirming Workers deployment is stable)

## Benefits of Migration

1. **Workers-exclusive features**: Access to rate limiters, durable objects, persistent logs
2. **Better metrics**: Enhanced dashboard monitoring and analytics
3. **Increased CPU time**: 30 seconds vs 100ms for Pages
4. **Unified platform**: All Workers features available
5. **Future-proof**: Active development continues on Workers, not Pages
6. **PR previews**: Automatic preview deployments for every pull request

## Considerations

### Static Assets Only
Since this is a SPA with `adapter-static`, we don't need:
- Server-side rendering setup
- Dynamic environment variables at runtime
- Worker script (`_worker.js`)

### Environment Variables
All environment variables are baked into the build at compile time (standard for static SPAs). No runtime environment variable access needed.

### Rollback Plan
If issues arise:
1. Keep the old `wrangler pages deploy` command available
2. The Pages project remains until explicitly deleted
3. Can switch DNS back to Pages if needed

## Testing Strategy

1. **Local testing**: Use `wrangler dev` to test locally
2. **Preview testing**: Create a test PR to verify preview deployment
3. **Production testing**: Deploy to Workers and verify against Pages
4. **Parallel running**: Run both Pages and Workers simultaneously during transition
5. **DNS cutover**: Switch DNS only after confirming Workers deployment is stable

## Review Section

### Changes Made

#### 1. Created `wrangler.toml` Configuration
- Added Worker configuration file at `apps/whispering/wrangler.toml`
- Configured static assets to serve from `build/` directory (not `dist/`)
- Set up preview environment support with unique worker names
- Created minimal worker script at `src/index.js` to serve static assets via ASSETS binding

#### 2. Updated Deployment Scripts
- Modified `package.json` deploy script from `wrangler pages deploy` to `wrangler deploy`
- Added `deploy:preview` script for testing preview deployments locally
- No changes to build process required (adapter-static works perfectly)

#### 3. Updated GitHub Actions Workflow
- Modified `.github/workflows/deploy-cloudflare.yml`:
  - Changed from `wrangler pages deploy` to `wrangler deploy`
  - Removed Pages-specific flags (`--project-name`, `--branch`, `--commit-hash`, etc.)
  - Updated artifact paths from `dist` to `build`
  - Simplified deployment command structure
  - Updated URL extraction pattern for Workers deployment URLs

#### 4. Created PR Preview Workflow
- Added new `.github/workflows/preview-deployment.yml`
- Deploys unique Worker per PR (`whispering-pr-123`)
- Updates existing PR comments instead of creating duplicates
- Only triggers on changes to relevant files (`apps/whispering/**`, `packages/**`)
- Uses concurrency control to cancel in-progress deployments

### Testing Results

#### Local Dry-Run Test
- ✅ Build completed successfully with `bun run build`
- ✅ Build output correctly placed in `build/` directory
- ✅ `wrangler deploy --dry-run` passed validation
- ✅ Worker script successfully configured with ASSETS binding
- ✅ Total upload size: 0.18 KiB / gzip: 0.15 KiB (very lightweight)

#### Key Discovery
- Build output is in `build/` directory, not `dist/` (adapter-static default)
- Worker script needs to reference `env.ASSETS` (not `STATIC_ASSETS` as in some docs)
- Preview environment warning suggests using `--env=""` for production deploys

### Issues Encountered

#### 1. Build Directory Confusion
**Issue**: Initial config used `dist/` directory, but adapter-static outputs to `build/`
**Resolution**: Updated `wrangler.toml` to use `directory = "build"`

#### 2. Environment Warning
**Warning**: Wrangler warns about multiple environments without explicit target
**Impact**: Minor; suggests using `--env=""` for top-level environment
**Resolution**: Can be addressed by adding explicit environment flag in CI/CD or restructuring config

### Next Steps

#### Before Production Deployment
1. ✅ Test dry-run locally (COMPLETED)
2. ⏭️ Test actual deployment to Workers (requires Cloudflare credentials)
3. ⏭️ Verify Worker serves the SPA correctly
4. ⏭️ Test SPA routing (ensure fallback to index.html works)
5. ⏭️ Test a PR to verify preview deployment workflow

#### After Successful Testing
1. Deploy to production Workers
2. Set up custom domain routing via Cloudflare dashboard
3. Verify production deployment works correctly
4. Update DNS to point to Workers (optional, if using custom domain)
5. Monitor for any issues
6. Delete old Pages project after confirming stability

#### Optional Enhancements
1. Add cleanup workflow to delete preview Workers when PR closes
2. Configure custom domains in `wrangler.toml` once DNS is ready
3. Add Workers-specific features (rate limiting, KV storage, etc.)
4. Set up more sophisticated error handling/logging

### Recommendations

1. **Test Thoroughly**: Deploy to Workers alongside Pages first, test both in parallel
2. **Monitor Metrics**: Compare performance between Pages and Workers deployments
3. **Keep Rollback Ready**: Don't delete Pages project until Workers is proven stable
4. **Consider Cleanup**: Add workflow to delete preview Workers when PRs close to avoid worker proliferation
5. **Update Documentation**: Update project README with new deployment instructions

### Final Cleanup (Post-Review)

After review, simplified the configuration by removing unnecessary complexity:

1. **Removed `deploy:preview` script** - Not useful since PR previews are automated via GitHub Actions
2. **Removed `[env.preview]` from wrangler.toml** - PR preview workflow uses `--name` flag directly instead
3. **Simplified main deployment workflow** - Removed preview environment option from workflow_dispatch
4. **Cleaned up workflow references** - Removed all `github.event.inputs.environment` references
5. **Updated workflow name** - Changed from "Deploy to Cloudflare Pages" to "Deploy to Cloudflare Workers"

### Summary

The migration from Cloudflare Pages to Workers is complete and tested locally. The implementation is straightforward because Whispering uses adapter-static for a pure SPA build. The key changes were:

- Minimal `wrangler.toml` configuration pointing to `build/` directory
- Minimal worker script that serves static assets via ASSETS binding
- Updated GitHub Actions workflows for both production and PR previews
- PR preview workflow uses `--name` flag to create unique workers per PR
- No changes to the build process or application code
- No unnecessary environment configurations or preview scripts

The dry-run test confirms the configuration is valid and ready for actual deployment. Next step is to test with real Cloudflare credentials.
