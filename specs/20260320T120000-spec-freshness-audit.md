# Spec Freshness Audit

**Date**: 2026-03-20
**Status**: Complete
**Purpose**: Update four stale specifications to match the current codebase after significant architectural evolution

---

## Problem

Several specs have drifted from the actual implementation. The sync architecture spec describes an org-ownership model that was explicitly rejected. The hub-sidecar spec references packages that were never created. The encrypted workspace storage spec has five stacked "superseded by" notes. Only the HKDF spec is mostly current.

This causes real damage: anyone reading these specs (including AI agents) builds a wrong mental model of how the system works.

## Approach

Each spec gets the treatment that fits its drift level:

| Spec | Drift | Treatment |
|---|---|---|
| Sync Architecture | Severe: core model changed | Add "Current Reality" section at top; mark original content as historical |
| Hub-Sidecar Architecture | Moderate: hub exists, sidecar doesn't | Update status; add "What Exists vs Planned" section |
| HKDF Key Derivation | Minor: env var name differs | In-place fixes to match `ENCRYPTION_SECRETS` keyring |
| Encrypted Workspace Storage | Severe: everything superseded | Mark as archived; add clear redirect to current specs |

The philosophy: don't delete historical content (it explains why decisions were made), but make it crystal clear what's current and what's historical. A reader should know within the first 10 lines whether a spec matches the code.

## Todo

- [x] **Sync Architecture** (`20260121T170000`): Status → "Outdated". Added "Current Reality (2026-03-20)" section documenting per-user DO naming, Cloudflare DOs, cloud-only mode, with reference to the app.ts rationale comment. Marked original body as "Original Design (January 2026)".
- [x] **Hub-Sidecar Architecture** (`20260304T120000`): Status → "Partially Implemented". Added "Current State (2026-03-20)" section listing what exists (hub at `apps/api/`) and what doesn't (sidecar, tiers 2-3, package restructure). Marked the package structure section as "Planned, Not Started" with a note that source packages were deleted.
- [x] **HKDF Key Derivation** (`20260314T070000`): In-place fixes. Updated "Desired State" code example to show `ENCRYPTION_SECRETS` keyring with versioned entries and `keyVersion` in session response. Updated Design Decisions table to document `ENCRYPTION_SECRETS` instead of `BETTER_AUTH_SECRET`. Updated key hierarchy diagram root label.
- [x] **Encrypted Workspace Storage** (`20260213T005300`): Status → "Archived". Added a redirect table at the top mapping each superseded topic to its replacement spec. Reorganized the five stacked notes under a "Historical notes" heading. All original content preserved.

## Review

All four specs updated with the philosophy: preserve historical content, make current state immediately obvious.

The approach varied by drift level:

- **Severe drift** (sync architecture, encrypted storage): Added prominent new sections at the top that redirect readers to current reality. Original content stays but is clearly labeled as historical. This is better than rewriting because the original thinking explains why these designs were explored. Useful context for future decisions.
- **Moderate drift** (hub-sidecar): Added a "Current State" section that inventories what shipped vs what's planned. The spec remains useful as a roadmap for self-hosted and enterprise tiers.
- **Minor drift** (HKDF): In-place fixes only. The architecture is correct; just the secret source name evolved from `BETTER_AUTH_SECRET` to `ENCRYPTION_SECRETS` with a versioned keyring, which is an improvement worth documenting.

No code changes were required. This was purely documentation.
