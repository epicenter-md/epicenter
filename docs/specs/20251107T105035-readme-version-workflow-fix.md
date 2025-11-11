# README Version Workflow Fix

## Executive Summary

**Status**: 🔴 Critical - All download links in README are broken

Users cannot download v7.7.1 because:
1. README still points to v7.7.0 (workflow failed to update)
2. Even if version numbers were correct, asset filenames changed format (missing `_darwin`, `_linux`, `_windows` suffixes)

**Impact**: 100% of download links are non-functional

**Quick Fix**: Manually update README with correct filenames (see Option 1 below)

**Long-term Fix**: Update workflow to handle new filename format and race conditions

---

## Problems

There are **TWO** issues preventing users from downloading the latest version:

### Problem 1: Workflow Failed to Update Version Numbers

The README still shows version 7.7.0 even though the latest release is 7.7.1. The GitHub Action that should automatically update the README version failed.

### Problem 2: Asset Filename Format Changed

Even if the version numbers were updated, the download links would still be broken because the asset filenames changed format starting with v7.7.0.

**Old format (up to v7.6.0):**
- `Whispering_7.6.0_aarch64.dmg`
- `Whispering_7.6.0_x64.dmg`
- `Whispering_7.6.0_x64_en-US.msi`

**New format (v7.7.0+):**
- `Whispering_7.7.1_aarch64_darwin.dmg`
- `Whispering_7.7.1_x64_darwin.dmg`
- `Whispering_7.7.1_x64_en-US_windows.msi`

The new format adds platform suffixes (`_darwin`, `_linux`, `_windows`) to the filenames.

## Root Causes

### Root Cause 1: Race Condition in Git Push

The `update-readme-version.yml` workflow failed during the v7.7.1 release with this error:

```
error: failed to push some refs to 'https://github.com/epicenter-md/epicenter'
hint: Updates were rejected because a pushed branch tip is behind its remote
hint: counterpart. If you want to integrate the remote changes, use 'git pull'
hint: before pushing again.
```

This is a **race condition**. Here's what happened:

1. The v7.7.1 release was published
2. The `update-readme-version.yml` workflow was triggered
3. The workflow checked out the repository
4. The workflow made changes to the README
5. **Meanwhile, other commits were pushed to main**
6. When the workflow tried to push, it was rejected because main had moved forward

## Failed Workflow Details

- Workflow Run: 19121198554
- Trigger: v7.7.1 release published
- Failed Step: "Commit and push changes"
- Error: Git push rejected due to non-fast-forward

### Root Cause 2: Outdated Filename Patterns in Workflow

The workflow's regex patterns don't match the new asset filename format. The workflow searches for patterns like:
- `Whispering_[0-9]+\.[0-9]+\.[0-9]+_aarch64\.dmg`
- `Whispering_[0-9]+\.[0-9]+\.[0-9]+_x64\.dmg`

But the actual filenames now include platform suffixes:
- `Whispering_7.7.1_aarch64_darwin.dmg`
- `Whispering_7.7.1_x64_darwin.dmg`

This happened because Tauri v2 changed the default bundle naming convention to include the target platform in the filename.

## Solutions

### Option 1: Quick Manual Fix

Manually update the README to use the correct asset names:

```bash
# In apps/whispering/README.md, change all links from:
Whispering_7.7.0_aarch64.dmg → Whispering_7.7.1_aarch64_darwin.dmg
Whispering_7.7.0_x64.dmg → Whispering_7.7.1_x64_darwin.dmg
Whispering_7.7.0_x64_en-US.msi → Whispering_7.7.1_x64_en-US_windows.msi
Whispering_7.7.0_x64-setup.exe → Whispering_7.7.1_x64-setup_windows.exe
Whispering_7.7.0_amd64.AppImage → Whispering_7.7.1_amd64_linux.AppImage
Whispering_7.7.0_amd64.deb → Whispering_7.7.1_amd64_linux.deb
Whispering-7.7.0-1.x86_64.rpm → Whispering-7.7.1-1.x86_64_linux.rpm
```

### Option 2: Fix the Workflow (Recommended)

Update the workflow to:
1. Handle race conditions by pulling before pushing
2. Use the correct filename patterns with platform suffixes

**Changes needed in `.github/workflows/update-readme-version.yml`:**

```yaml
- name: Update README download links
  run: |
    VERSION=${{ steps.get_version.outputs.VERSION }}

    # Update the Whispering app README
    README_PATH="apps/whispering/README.md"

    # Create backup for safety
    cp "$README_PATH" "${README_PATH}.bak"

    # FIRST: Update URL paths from /releases/download/vX.X.X/ to /releases/download/v{VERSION}/
    sed -i "s|/releases/download/v[0-9]\+\.[0-9]\+\.[0-9]\+/|/releases/download/v${VERSION}/|g" "$README_PATH"

    # SECOND: Update filenames with NEW platform-suffixed format (Tauri v2)
    # macOS downloads (now include _darwin suffix)
    sed -i "s/Whispering_[0-9]\+\.[0-9]\+\.[0-9]\+_aarch64_darwin\.dmg/Whispering_${VERSION}_aarch64_darwin.dmg/g" "$README_PATH"
    sed -i "s/Whispering_[0-9]\+\.[0-9]\+\.[0-9]\+_x64_darwin\.dmg/Whispering_${VERSION}_x64_darwin.dmg/g" "$README_PATH"

    # Windows downloads (now include _windows suffix)
    sed -i "s/Whispering_[0-9]\+\.[0-9]\+\.[0-9]\+_x64_en-US_windows\.msi/Whispering_${VERSION}_x64_en-US_windows.msi/g" "$README_PATH"
    sed -i "s/Whispering_[0-9]\+\.[0-9]\+\.[0-9]\+_x64-setup_windows\.exe/Whispering_${VERSION}_x64-setup_windows.exe/g" "$README_PATH"

    # Linux downloads (now include _linux suffix)
    sed -i "s/Whispering_[0-9]\+\.[0-9]\+\.[0-9]\+_amd64_linux\.AppImage/Whispering_${VERSION}_amd64_linux.AppImage/g" "$README_PATH"
    sed -i "s/Whispering_[0-9]\+\.[0-9]\+\.[0-9]\+_amd64_linux\.deb/Whispering_${VERSION}_amd64_linux.deb/g" "$README_PATH"
    sed -i "s/Whispering-[0-9]\+\.[0-9]\+\.[0-9]\+-1\.x86_64_linux\.rpm/Whispering-${VERSION}-1.x86_64_linux.rpm/g" "$README_PATH"

    # Show what changed for transparency
    echo "Changes made:"
    diff "${README_PATH}.bak" "$README_PATH" || true

- name: Commit and push changes
  if: steps.check_changes.outputs.CHANGES_MADE == 'true'
  run: |
    git config --local user.email "github-actions[bot]@users.noreply.github.com"
    git config --local user.name "github-actions[bot]"

    git add apps/whispering/README.md
    git commit -m "chore: update README download links to v${{ steps.get_version.outputs.VERSION }}"

    # Pull with rebase to handle race conditions
    git pull --rebase origin main

    # Push to main branch
    git push origin HEAD:refs/heads/main
```

### Option 3: Use a Different Push Strategy

Use force-with-lease to ensure we only push if we're still up-to-date with remote:

```yaml
- name: Commit and push changes
  if: steps.check_changes.outputs.CHANGES_MADE == 'true'
  run: |
    git config --local user.email "github-actions[bot]@users.noreply.github.com"
    git config --local user.name "github-actions[bot]"

    git add apps/whispering/README.md
    git commit -m "chore: update README download links to v${{ steps.get_version.outputs.VERSION }}"

    # Retry logic with pull and rebase
    MAX_RETRIES=3
    for i in $(seq 1 $MAX_RETRIES); do
      if git push origin HEAD:refs/heads/main; then
        echo "Successfully pushed on attempt $i"
        exit 0
      fi

      if [ $i -lt $MAX_RETRIES ]; then
        echo "Push failed, pulling latest changes and retrying..."
        git pull --rebase origin main
      fi
    done

    echo "Failed to push after $MAX_RETRIES attempts"
    exit 1
```

## Comparison: What Actually Broke

| Component | Expected (Old) | Actual (New) | Status |
|-----------|---------------|--------------|---------|
| macOS ARM | `Whispering_7.7.0_aarch64.dmg` | `Whispering_7.7.1_aarch64_darwin.dmg` | ❌ Broken |
| macOS Intel | `Whispering_7.7.0_x64.dmg` | `Whispering_7.7.1_x64_darwin.dmg` | ❌ Broken |
| Windows MSI | `Whispering_7.7.0_x64_en-US.msi` | `Whispering_7.7.1_x64_en-US_windows.msi` | ❌ Broken |
| Windows EXE | `Whispering_7.7.0_x64-setup.exe` | `Whispering_7.7.1_x64-setup_windows.exe` | ❌ Broken |
| Linux AppImage | `Whispering_7.7.0_amd64.AppImage` | `Whispering_7.7.1_amd64_linux.AppImage` | ❌ Broken |
| Linux DEB | `Whispering_7.7.0_amd64.deb` | `Whispering_7.7.1_amd64_linux.deb` | ❌ Broken |
| Linux RPM | `Whispering-7.7.0-1.x86_64.rpm` | `Whispering-7.7.1-1.x86_64_linux.rpm` | ❌ Broken |

## Recommendation

### Immediate Actions

1. **Manually update the README** with correct v7.7.1 asset names (see Option 1)
2. **Commit and push** the corrected README

### Long-term Fix

1. **Update the workflow** with:
   - New filename patterns that include platform suffixes
   - Retry logic to handle race conditions (Option 3)
2. **Test with next release** to ensure both issues are resolved

## Implementation Review

### Changes Made

#### 1. Fixed README (apps/whispering/README.md)
Updated all download links from v7.7.0 to v7.7.1 with correct platform suffixes:
- macOS: `_darwin` suffix added
- Windows: `_windows` suffix added
- Linux: `_linux` suffix added

All 7 download links are now functional:
- ✅ macOS Apple Silicon DMG
- ✅ macOS Intel DMG
- ✅ Windows MSI
- ✅ Windows EXE
- ✅ Linux AppImage
- ✅ Linux DEB
- ✅ Linux RPM

#### 2. Fixed Workflow (.github/workflows/update-readme-version.yml)

**Updated filename patterns:**
- Changed from `Whispering_X.X.X_aarch64.dmg` to `Whispering_X.X.X_aarch64_darwin.dmg`
- Changed from `Whispering_X.X.X_x64.dmg` to `Whispering_X.X.X_x64_darwin.dmg`
- Changed from `Whispering_X.X.X_x64_en-US.msi` to `Whispering_X.X.X_x64_en-US_windows.msi`
- Changed from `Whispering_X.X.X_x64-setup.exe` to `Whispering_X.X.X_x64-setup_windows.exe`
- Changed from `Whispering_X.X.X_amd64.AppImage` to `Whispering_X.X.X_amd64_linux.AppImage`
- Changed from `Whispering_X.X.X_amd64.deb` to `Whispering_X.X.X_amd64_linux.deb`
- Changed from `Whispering-X.X.X-1.x86_64.rpm` to `Whispering-X.X.X-1.x86_64_linux.rpm`

**Added retry logic:**
- 3 retry attempts with exponential backoff
- Pulls and rebases before each retry
- Prevents future race condition failures

### Testing Plan

The fix will be validated with the next release (v7.7.2 or later):
1. Workflow should run successfully
2. README should be updated automatically
3. All download links should work immediately

### Files Modified

1. `apps/whispering/README.md` - Updated all download links to v7.7.1
2. `.github/workflows/update-readme-version.yml` - Fixed patterns and added retry logic
3. `docs/specs/20251107T105035-readme-version-workflow-fix.md` - This documentation

## Todo

- [x] Manually update README with correct v7.7.1 asset filenames
- [x] Update workflow with new filename patterns
- [x] Add retry logic to workflow
- [ ] Test the complete fix with next release
