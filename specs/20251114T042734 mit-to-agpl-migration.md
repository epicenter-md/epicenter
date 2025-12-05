# MIT to AGPL-3.0 License Migration Specification

## Overview

This specification outlines the plan to migrate the Epicenter repository from the MIT license to the AGPL-3.0 (GNU Affero General Public License v3.0) license, as part of the dual-licensing strategy discussed in issue #792.

## Background

As discussed in [issue #792](https://github.com/EpicenterHQ/epicenter/issues/792), the project is moving toward a dual-license model to ensure sustainability while remaining true to open-source principles. The AGPL-3.0 license will be the copyleft option, available freely for anyone building open-source software. Companies wanting to use the framework in closed-source products can purchase a commercial license.

This approach is used by successful projects like Cal.com, dub.sh, and others, balancing community support with business sustainability.

## Scope of Changes

### Files Requiring Updates

1. **LICENSE file**
   - Replace MIT license text with AGPL-3.0 license text
   - Update copyright year to 2023-2025
   - Maintain copyright holder as "Braden Wong"

2. **package.json** (root)
   - Change `"license": "ISC"` to `"license": "AGPL-3.0"`
   - Note: Currently shows "ISC" but should be updated to match new license

3. **README.md**
   - Update license badge from MIT to AGPL-3.0
   - Update license section at bottom to reflect new license
   - Add brief note about dual-licensing model (optional for initial PR)

4. **apps/whispering/package.json**
   - Update license field if present
   - Need to check if this file has a license field

5. **Other documentation files** (if they reference the license)
   - SECURITY.md
   - CODE_OF_CONDUCT.md
   - CONTRIBUTING.md (if it exists)
   - Any other files found by grep

### Files NOT Requiring Changes

- Source code files: AGPL-3.0 does not require license headers in every source file (unlike some other licenses)
- Build configuration files
- GitHub workflows/actions

## Implementation Steps

### Step 1: Replace LICENSE File

Replace the current MIT license text with the full AGPL-3.0 license text:

```
GNU AFFERO GENERAL PUBLIC LICENSE
Version 3, 19 November 2007

Copyright (C) 2023-2025 Braden Wong
...
[Full AGPL-3.0 text]
```

### Step 2: Update package.json

Change the license field from "ISC" to "AGPL-3.0":

```json
{
  "license": "AGPL-3.0"
}
```

### Step 3: Update README.md

1. Update the license badge (line 34):
   ```markdown
   <!-- Before -->
   <img alt="MIT License" src="https://img.shields.io/github/license/EpicenterHQ/epicenter.svg?style=flat-square" />

   <!-- After -->
   <img alt="AGPL-3.0 License" src="https://img.shields.io/github/license/EpicenterHQ/epicenter.svg?style=flat-square" />
   ```

2. Update the license section (line 163):
   ```markdown
   <!-- Before -->
   [MIT](LICENSE). Build on it. Fork it. Make it yours. Please contribute if you can.

   <!-- After -->
   [AGPL-3.0](LICENSE). Build on it. Fork it. Make it yours. Please contribute if you can.
   ```

### Step 4: Check and Update Other Files

Review and update any other files that reference the MIT license:
- SECURITY.md
- CODE_OF_CONDUCT.md
- Any blog posts or documentation in apps/epicenter/src/

## Communication Plan

### GitHub Pull Request

- Create a draft pull request
- Reference issue #792 (but do NOT close it)
- Title: `chore: migrate from MIT to AGPL-3.0 license`
- Explain the reasoning briefly
- Note that this is the first step toward the dual-licensing model

### Discord Announcement (Post-Merge)

After the PR is merged, announce to the 6 maintainers on Discord:
- Brief explanation of the change
- Link to issue #792 for full context
- Reassure that this doesn't affect their ability to contribute
- Mention the dual-licensing strategy for sustainability

## Important Considerations

### What This Changes

- The project becomes copyleft: modifications must be shared under the same license
- Network use triggers disclosure: if someone runs a modified version as a service, they must share the source (this is the key difference from GPL)
- Commercial entities using this in closed-source products would need a commercial license

### What This Doesn't Change

- Open-source contributors can still use, modify, and distribute the code freely
- The core philosophy of transparency and data ownership remains
- Existing users are not affected
- The codebase remains fully open source

### Legal Notes

- This is NOT legal advice
- Consider consulting with a lawyer for the commercial licensing terms
- Ensure all contributors are aware of the license change
- Check if any dependencies have license compatibility issues with AGPL-3.0

## Timeline

1. Create specification document (this document) ✓
2. Draft pull request description
3. Review with maintainer
4. Update all relevant files
5. Test that nothing breaks (build, CI/CD)
6. Get approval and merge PR
7. Announce on Discord
8. Monitor for any issues or questions

## Checklist

- [ ] LICENSE file replaced with AGPL-3.0 text
- [ ] Root package.json updated
- [ ] README.md badge updated
- [ ] README.md license section updated
- [ ] apps/whispering/package.json checked and updated if needed
- [ ] Other documentation files checked
- [ ] Build and tests pass
- [ ] PR created and reviewed
- [ ] PR merged
- [ ] Discord announcement posted

## Questions to Address

1. Should we add a brief note in README.md about the dual-licensing model now, or wait until commercial licensing is set up?
2. Are there any dependencies with license compatibility issues?
3. Should we add a LICENSE-COMMERCIAL.md file as a placeholder?
4. Do we need to update any contributor documentation?

## Automation and Tooling

Automation scripts have been created to help with the migration:

### Available Scripts

1. **`scripts/migration-dry-run.sh`**: Preview changes without modifying files
2. **`scripts/validate-license.sh`**: Validate migration was completed correctly
3. **`scripts/check-dependency-licenses.sh`**: Check for license compatibility issues

### Detailed Execution Guide

See [MIGRATION-GUIDE.md](./MIGRATION-GUIDE.md) for:
- Step-by-step programmatic execution
- Detailed validation procedures
- Rollback instructions
- Making the process reusable

### Script Documentation

See [scripts/README.md](../../scripts/README.md) for:
- Script usage and examples
- Recommended workflow
- Troubleshooting tips

## References

- [AGPL-3.0 Full Text](https://www.gnu.org/licenses/agpl-3.0.txt)
- [Issue #792: AGPL v3 Dual Licensing Model](https://github.com/EpicenterHQ/epicenter/issues/792)
- [Cal.com License](https://github.com/calcom/cal.com/blob/main/LICENSE)
- [Dub.sh License](https://github.com/dubinc/dub/blob/main/LICENSE.md)
- [MIGRATION-GUIDE.md](./MIGRATION-GUIDE.md): Detailed programmatic execution guide
- [scripts/README.md](../../scripts/README.md): Automation script documentation
