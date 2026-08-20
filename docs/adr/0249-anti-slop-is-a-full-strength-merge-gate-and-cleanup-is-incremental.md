# 0249. Anti-slop is a full-strength merge gate, and cleanup is incremental

- **Status:** Accepted
- **Date:** 2026-08-19
- **Provisional number.** The merge owner reconciles this number against other open ADRs before merge.

## Context

The repository has installed the generic anti-slop Oxlint plugin at
`tools/oxlint/anti-slop/`. Its fifteen rules encode the TypeScript contracts
this repository wants to enforce. At adoption time, the rules report a large
set of findings that predate the plugin.

The repository can either hide those findings behind a baseline or run the
rules at full strength immediately. A baseline would make the first check
green, but it would add a second exemption mechanism and would allow new
findings in already-dirty files to remain invisible. The repository accepts a
red transition instead.

## Decision

Anti-slop runs at upstream stock severity from the first adoption change. Every
generic rule remains an `error`. No baseline, blanket suppression, or weakened
rule is part of the design.

The root `lint:slop` script runs Oxlint over the entire repository, and
`bun run check` invokes it as part of the merge gate. Existing findings remain
visible and make the check fail until cleanup removes them.

During the cleanup period, an administrator may merge a pull request with
`gh pr merge --admin` only after confirming that anti-slop is the sole failing
check and that all other reviews and checks are satisfactory. GitHub's admin
override bypasses merge requirements generally; it is not a technical
override scoped to one check. This is a temporary transition practice, not a
normal merge path.

Cleanup proceeds incrementally in coherent batches. A cleanup batch fixes the
underlying contract rather than laundering the finding with a blanket disable,
an invented `SAFETY:` comment, or a mechanical type reshaping. The transition
is complete when `bun run lint:slop` exits successfully and the merge gate no
longer needs an administrator override.

## Consequences

- The adoption pull request is expected to report the existing debt and may
  require an administrator merge.
- Until the repository is clean, the full check does not distinguish old
  findings from new regressions. That loss of precision is accepted to keep
  the mechanism small and honest.
- `lint:slop` is already the complete report, so a second `lint:slop:all`
  command is unnecessary.
- Biome remains the repository's formatter and general linter. Oxlint owns
  only the anti-slop rules.
- Exact Oxlint and `@oxlint/plugins` versions remain pinned together because
  the JavaScript plugin runtime is not a stable compatibility boundary.

## Rejected alternative

**Delete-only file baseline.** Rejected because it adds a temporary exemption
list and creates a file-level hole: new findings in a listed file can pass
until that file is cleaned. A full-strength check with an explicit, temporary
administrator override is simpler and preserves the complete finding list.
