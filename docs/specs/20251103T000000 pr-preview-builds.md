# PR Preview Builds

## Problem
Currently, GitHub Actions only build Tauri releases when a new version tag is pushed. We want to enable preview builds for every pull request so contributors and reviewers can test changes before merging.

## Solution
Create a new GitHub Actions workflow that:
1. Triggers on pull request events (opened, synchronized, reopened)
2. Builds Tauri apps for all platforms (macOS ARM/Intel, Linux, Windows)
3. Uploads build artifacts to the pull request
4. Does NOT create a GitHub release (just artifacts)
5. Skips code signing and notarization (not needed for preview builds)

## Todo Items

- [ ] Create new workflow file `.github/workflows/pr-preview-builds.yml`
- [ ] Configure trigger for pull request events
- [ ] Reuse build matrix from publish-tauri-releases.yml
- [ ] Remove release creation steps (keep only artifact upload)
- [ ] Remove code signing steps (APPLE_CERTIFICATE, TAURI_SIGNING, etc.)
- [ ] Keep essential build dependencies (Vulkan, system deps, etc.)
- [ ] Configure artifact upload with clear naming
- [ ] Test workflow with a sample PR

## Key Differences from Release Workflow

**Keep:**
- Platform matrix (macOS ARM/Intel, Linux, Windows)
- System dependencies installation
- Vulkan SDK setup
- Frontend build steps
- Rust toolchain and caching
- AppImage libwayland-client.so removal

**Remove:**
- Release notes processing
- GitHub release creation
- Code signing (APPLE_CERTIFICATE, TAURI_SIGNING_PRIVATE_KEY)
- Notarization (APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID)
- Draft release settings

**Change:**
- Trigger: `on: pull_request` instead of `on: push: tags`
- Use `actions/upload-artifact` instead of creating releases
- Add PR number to artifact names for easy identification

## Implementation Notes

The tauri-action supports both release and artifact-only modes. We'll use:
- Set `tagName: ''` to skip release creation
- Artifacts will be automatically uploaded by tauri-action
- We can add a comment to the PR with download links using a separate step

## Review

### Implementation Complete

Created `.github/workflows/pr-preview-builds.yml` with the following features:

**Triggers:**
- Runs on pull_request events: opened, synchronize, reopened
- This ensures builds run when PRs are created or updated

**Build Configuration:**
- Reuses the same platform matrix as release workflow
- Builds for macOS (ARM + Intel), Ubuntu, and Windows
- Includes all system dependencies (Vulkan SDK, system libs)
- Performs AppImage libwayland-client.so removal for Linux compatibility

**Key Changes from Release Workflow:**
- Removed all code signing environment variables (APPLE_CERTIFICATE, TAURI_SIGNING_PRIVATE_KEY, etc.)
- Removed release notes processing step
- Set `tagName: ''` in tauri-action to skip release creation
- Added artifact upload step with PR number in name for easy identification
- Changed permissions to read contents + write pull-requests

**Artifact Naming:**
- Format: `whispering-pr{PR_NUMBER}-{PLATFORM}-{TARGET}`
- Examples:
  - `whispering-pr123-macos-latest-aarch64-apple-darwin`
  - `whispering-pr123-ubuntu-22.04-default`
  - `whispering-pr123-windows-latest-default`

**How to Use:**
1. Create or update a pull request
2. Wait for builds to complete (visible in PR checks)
3. Download artifacts from the "Artifacts" section in the workflow run
4. Test the preview builds locally

**Benefits:**
- No need to create tags/releases for testing
- Reviewers can test actual builds before merging
- Faster iteration on PRs with build validation
- Artifacts are automatically cleaned up after 90 days (GitHub default)
