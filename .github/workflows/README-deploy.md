# Cloudflare Pages Deployment Setup

This document explains how to set up the CI/CD pipeline for deploying Whispering and Epicenter apps to Cloudflare Pages.

## Prerequisites

Before the workflow can run successfully, you need to:

1. Have both projects created in Cloudflare Pages:
   - `whispering` - For the Whispering app
   - `epicenter` - For the Epicenter app

2. Generate a Cloudflare API token with the following permissions:
   - Account: Cloudflare Pages:Edit
   - Zone: Page Rules:Edit (if using custom domains)

## Required GitHub Secrets

Add these secrets to your GitHub repository settings (Settings → Secrets and variables → Actions):

### Required Secrets

- **`CLOUDFLARE_API_TOKEN`** (Required)
  - Generate at: https://dash.cloudflare.com/profile/api-tokens
  - Create token with "Cloudflare Pages:Edit" permission
  - Scope to your specific account

- **`CLOUDFLARE_ACCOUNT_ID`** (Required)
  - Find in Cloudflare dashboard: Right sidebar → Account ID
  - Or via URL: `https://dash.cloudflare.com/<ACCOUNT_ID>/pages`

### Optional Secrets

- **`DISCORD_WEBHOOK_URL`** (Optional)
  - For deployment notifications to Discord
  - Create webhook in Discord: Server Settings → Integrations → Webhooks

## Workflow Features

The `deploy-cloudflare.yml` workflow provides:

### Automatic Deployments
- Triggers on every push to `main` branch
- Can be manually triggered via GitHub Actions UI
- Supports environment selection (production/preview)

### Build Validation
- Type checking for TypeScript code
- Linting with your configured linter
- Builds all packages before deployment
- Caches build artifacts for faster deployments

### Parallel Deployments
- Deploys both apps simultaneously after validation
- Each app has its own deployment environment
- Independent failure handling

### Environment Support
- **Production**: Default environment for main branch
- **Preview**: For testing changes before production
- Manual trigger allows environment selection

### Status Reporting
- GitHub deployment environments with URLs
- Workflow summaries with deployment links
- Optional Discord notifications
- Detailed logs for debugging

## Usage

### Automatic Deployment
Every push to `main` will automatically:
1. Validate the build
2. Deploy to production environment
3. Report status in GitHub

### Manual Deployment
1. Go to Actions tab in GitHub
2. Select "Deploy to Cloudflare Pages"
3. Click "Run workflow"
4. Choose branch and environment
5. Click "Run workflow" button

### Environment URLs

After successful deployment, access your apps at:

**Production:**
- Whispering: `https://whispering.pages.dev`
- Epicenter: `https://epicenter.pages.dev`

**Preview:**
- Whispering: `https://preview.whispering.pages.dev`
- Epicenter: `https://preview.epicenter.pages.dev`

**Deployment-specific URLs:**
- Format: `https://<commit-hash>.whispering.pages.dev`
- Automatically generated for each deployment
- Found in workflow summary after deployment

## Troubleshooting

### Common Issues

1. **"Cloudflare API token is invalid"**
   - Verify token has correct permissions
   - Check token hasn't expired
   - Ensure token is correctly added to GitHub secrets

2. **"Project not found"**
   - Create projects in Cloudflare Pages dashboard first
   - Verify project names match: `whispering` and `epicenter`

3. **"Build failed"**
   - Check build logs in GitHub Actions
   - Ensure all dependencies are in package.json
   - Verify NODE_ENV=production doesn't break build

4. **"Deployment failed but build succeeded"**
   - Check Cloudflare Pages quotas
   - Verify account ID is correct
   - Check for Cloudflare service issues

### Debugging Steps

1. **Check workflow logs**: Click on failed job → View detailed logs
2. **Verify secrets**: Settings → Secrets → Check last updated dates
3. **Test locally**: Run `bun run build` in each app directory
4. **Manual deployment**: Try `bunx wrangler pages deploy` locally

## Rollback Procedure

If a deployment causes issues:

1. **Via Cloudflare Dashboard:**
   - Go to Cloudflare Pages → Your project
   - Click "View build history"
   - Find previous successful deployment
   - Click "Rollback to this deployment"

2. **Via GitHub:**
   - Revert the problematic commit
   - Push to main (triggers new deployment)

## Monitoring

Monitor your deployments through:

1. **GitHub Actions**: Actions tab → Workflow runs
2. **GitHub Environments**: Settings → Environments
3. **Cloudflare Dashboard**: Analytics and logs
4. **Discord**: If webhook configured

## Security Notes

- Never commit API tokens or secrets
- Use GitHub secrets for all sensitive data
- Rotate API tokens periodically
- Use least-privilege tokens
- Consider IP restrictions on tokens for production

## Support

For issues with:
- **GitHub Actions**: Check GitHub Status
- **Cloudflare Pages**: Check Cloudflare Status
- **This workflow**: Create an issue in the repository