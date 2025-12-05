# Homebrew Cask Rename: epicenter-whispering → whispering

**Created**: 2025-11-28
**Status**: Ready to implement (waiting for homebrew PR merge)
**Homebrew PR**: https://github.com/Homebrew/homebrew-cask/pull/238623

## Context

The Whispering app is being renamed in Homebrew from `epicenter-whispering` to `whispering` to better match how users search for and identify the application. The app installs as "Whispering.app" so the epicenter prefix creates unnecessary confusion.

The homebrew PR is currently in the merge queue. Once it merges, we need to update all documentation references to use the new cask name.

## Strategy

1. **Prepare changes NOW** (before homebrew PR merges)
2. **Create PR** with all documentation updates
3. **Wait for homebrew PR** to merge
4. **Immediately merge this PR** once homebrew is live

This ensures documentation is accurate the moment the new cask name becomes available.

## Files to Update

### Primary Installation Documentation

| File | Line | Change |
|------|------|--------|
| `README.md` | 103 | `brew install --cask epicenter-whispering` → `brew install --cask whispering` |
| `apps/whispering/README.md` | 93 | `brew install --cask epicenter-whispering` → `brew install --cask whispering` |

### Other Homebrew References (No Changes Needed)

These files mention homebrew but are unrelated to the cask rename:

- `.github/workflows/publish-tauri-releases.yml` (line 42): Installing create-dmg via homebrew
- `.github/workflows/pr-preview-builds.yml` (line 69): Installing create-dmg via homebrew
- `README.md` (line 122): Comment about installing Rust via homebrew
- `logos/README.md` (line 42): Installing ImageMagick via homebrew
- `apps/whispering/src/routes/(app)/(config)/install-ffmpeg/+page.svelte`: Instructions for installing ffmpeg
- `apps/cli/README.md`: Instructions for installing cloudflared and ngrok
- `apps/cli/src/services/tunnel/ngrok.ts`: Error message for installing ngrok
- `apps/cli/src/services/tunnel/cloudflare.ts`: Error message for installing cloudflared
- `docs/guides/tauri-shell-commands.md`: Technical discussion about homebrew paths
- `apps/whispering/src-tauri/src/lib.rs`: Code comment about homebrew paths

## Implementation Checklist

- [ ] Update `README.md` line 103
- [ ] Update `apps/whispering/README.md` line 93
- [ ] Create commit with message: `docs: update homebrew cask name from epicenter-whispering to whispering`
- [ ] Create PR with clear note: "Ready to merge after homebrew/homebrew-cask#238623 merges"
- [ ] Monitor homebrew PR merge status
- [ ] Merge this PR immediately after homebrew PR lands

## How Homebrew Migration Works

According to [Homebrew's rename documentation](https://docs.brew.sh/Rename-A-Formula):

- The `cask_renames.json` file in the homebrew PR handles backward compatibility
- Existing users who run `brew upgrade` will automatically migrate from old to new name
- The old name `epicenter-whispering` will continue to work (redirects to `whispering`)
- No action required from existing users

## Testing Plan

After merging this PR:

1. **Verify new installation works**:
   ```bash
   brew install --cask whispering
   ```

2. **Verify old name still works** (should redirect):
   ```bash
   brew install --cask epicenter-whispering
   ```

3. **Verify upgrade works** for existing users:
   ```bash
   brew upgrade epicenter-whispering
   # Should upgrade to whispering cask
   ```

## Notes

- This is purely a documentation change - no code changes needed
- The rename only affects the homebrew cask token, not the app name or bundle ID
- Users will see "Whispering.app" regardless of which cask name they used to install

## Sources

- [Homebrew Cask Rename PR #238623](https://github.com/Homebrew/homebrew-cask/pull/238623)
- [Homebrew Documentation: Renaming a Formula or Cask](https://docs.brew.sh/Rename-A-Formula)
- [Homebrew Cask Cookbook](https://docs.brew.sh/Cask-Cookbook)
