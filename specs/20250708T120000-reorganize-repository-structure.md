# Reorganize Repository Structure

## Problem
The repository has multiple documentation and resource folders at the top level that make it look cluttered:
- `images/` - Contains demos, web store assets, and other images
- `launch-2025-07-07/` - Launch planning and marketing materials
- `release-notes/` - Version release notes
- `specs/` - Technical specifications and planning documents

## Solution
Consolidate these folders into a single `docs/` folder with clear subdirectories.

## Todo List
- [x] Create new `docs/` folder structure
- [x] Move `images/` to `docs/assets/images/`
- [x] Move `launch-2025-07-07/` to `docs/launch/`
- [x] Move `release-notes/` to `docs/release-notes/`
- [x] Move `specs/` to `docs/specs/`
- [x] Update GitHub Actions workflow to use new release notes path
- [x] Update AGENTS.md to reference new specs path
- [x] Update any other references in the codebase
- [ ] Remove any blog post files if found

## New Structure
```
docs/
├── assets/
│   └── images/
│       ├── demos/
│       └── web-store/
├── launch/
│   ├── demo-videos/
│   ├── planning/
│   └── platform-posts/
├── release-notes/
│   ├── README.md
│   └── v*.md files
└── specs/
    └── *.md files
```

## Benefits
- Cleaner top-level directory
- More intuitive for new users browsing the repository
- All documentation and resources in one logical place
- Maintains existing folder organization within the new structure

## Review

### Changes Made
1. Created new `docs/` directory structure with subdirectories for assets, launch, release-notes, and specs
2. Successfully moved all four folders into the new structure:
   - `images/` → `docs/assets/images/`
   - `launch-2025-07-07/` → `docs/launch/`
   - `release-notes/` → `docs/release-notes/`
   - `specs/` → `docs/specs/`
3. Updated all references in the codebase:
   - GitHub Actions workflow (`publish-tauri-releases.yml`) now looks for release notes in `docs/release-notes/`
   - `AGENTS.md` now references `docs/specs/` for specification files
   - Launch documentation (`CONTINUATION-PROMPT.md`) updated with new paths
   - Release notes README updated with correct directory references

### Result
The repository now has a much cleaner top-level structure with all documentation and resources consolidated under the `docs/` folder. This makes it easier for new users to navigate and understand the project structure when browsing on GitHub.