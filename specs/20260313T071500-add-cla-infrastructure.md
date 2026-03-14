# Add CLA Infrastructure

## Problem

HOW_TO_MONETIZE.md claims Epicenter follows the same AGPL dual-licensing approach as Grafana, MongoDB, Bitwarden, and MinIO—but omits that every one of those projects requires a Contributor License Agreement. Without a CLA:

1. Community contributions to commercially relevant code (sync server, sync protocol) can't be commercially licensed
2. Future relicensing is blocked by copyright fragmentation across ~30 contributors
3. The "add CLA later" approach creates a timing risk—any contribution that lands before the CLA is in place is permanently AGPL-only
4. CONTRIBUTING.md has zero mention of licensing, copyright, or contributor agreements

## Solution

Add a lightweight CLA using the CLA Assistant GitHub Action (signatures stored in-repo, no external dependencies), update CONTRIBUTING.md, fix HOW_TO_MONETIZE.md's misleading comps section, and add CODEOWNERS to gate commercially relevant paths.

## Commercially Relevant Code Paths

These directories contain the sync server and protocol code that Braden wrote 100% and intends to sell commercially:

- `apps/api/` — Sync server (Cloudflare Workers + Durable Objects)
- `packages/sync/` — Sync protocol library
- `packages/sync-client/` — Sync client library

## CLA Template Choice

**Apache-style ICLA (license grant, NOT copyright assignment).**

Why:
- Grafana uses a modified Apache ICLA—closest comp to Epicenter's model
- License grant is less intimidating to contributors than copyright assignment
- Grants the project perpetual, worldwide, royalty-free, non-exclusive right to sublicense contributions—which is exactly what's needed for dual-licensing
- Contributors retain copyright on their own code
- Standard, well-understood, legally tested

What the CLA covers:
- Copyright license: right to reproduce, prepare derivative works, sublicense, and distribute
- Patent license: non-exclusive patent grant for the contribution
- Contributor represents they have the right to submit the work
- Contributor represents the work is their original creation

## Implementation Plan

### Todo Items

- [x] **1. Draft CLA document** — Create `CLA.md` at repo root based on Apache ICLA template, adapted for Epicenter/EpicenterHQ. Keep it short (under 2 pages).

- [x] **2. Add CLA Assistant GitHub Action** — Create `.github/workflows/ci.cla.yml` that:
  - Triggers on `pull_request_target` and `issue_comment`
  - Comments on PRs from first-time contributors asking them to sign
  - Accepts signature via PR comment ("I have read the CLA Document and I hereby sign the CLA")
  - Stores signatures in `signatures/cla.json` in the repo
  - Allowlists bots (dependabot, renovate, etc.)

- [x] **3. Create CODEOWNERS** — Add `.github/CODEOWNERS` gating:
  - `apps/api/` → @braden-w (sync server)
  - `packages/sync/` → @braden-w (sync protocol)
  - `packages/sync-client/` → @braden-w (sync client)
  - This ensures all PRs touching commercially relevant code require Braden's explicit review

- [x] **4. Update CONTRIBUTING.md** — Add a "Licensing and CLA" section that:
  - States the project is AGPL-3.0
  - Explains that a CLA is required for contributions
  - Links to CLA.md
  - Notes that the CLA bot will prompt on first PR

- [x] **5. Update HOW_TO_MONETIZE.md** — Fix the misleading sections:
  - "Why not a CLA?" → Update to reflect that a CLA is now in place
  - Comps section → Add acknowledgment that all listed comps use CLAs
  - Keep the overall strategy and tone the same—just make it accurate

## What This Does NOT Change

- The AGPL-3.0 license stays
- The sustainability strategy stays (it was correct, just incomplete)
- Existing contributors' code remains under AGPL (their past contributions don't retroactively fall under the CLA)
- No copyright assignment—contributors keep their copyright

## Decisions Made

1. **CLA scope**: All contributions (matches Grafana/MongoDB/Bitwarden)
2. **CLA style**: Apache ICLA adapted for Epicenter
3. **Retroactive outreach**: Yes, belt-and-suspenders approach

## Retroactive Outreach Plan

**Key insight**: Existing contributions are already under AGPL. The CLA is about granting additional commercial sublicensing rights. Since existing contributions are in the desktop app (not the sync server), non-response does NOT block commercial licensing.

### Process

1. Run `git shortlog -sne` to identify all contributors + GitHub handles
2. Create a GitHub Discussion explaining the CLA, why it exists, and how to sign
3. Tag all ~30 contributors in the discussion
4. **30-day grace period** (industry standard)
5. For non-responders after 30 days:
   - Their existing code stays under AGPL (nothing changes for them)
   - Note which files they contributed to in an internal tracking doc
   - If you ever need to commercially license those specific files, rewrite them at that point
   - **No rebasing needed** you just create new commits replacing their code if/when needed
6. For responders: their signature goes into signatures/cla.json with a note that it covers past and future contributions

### Why NOT rebase/rewrite now

- Rewriting ~220 commits is massive effort for near-zero benefit
- Their code is in the desktop app, not the sync server
- The commercial product is the sync server, which is 100% Braden's code
- Rewriting would only matter if you wanted to sell the desktop app under a commercial license (you don't)

## Review

**Status**: Implemented

### Summary

All five spec items implemented in a single wave (all touched different files). Added CLA infrastructure following the Apache ICLA model with GitHub Action enforcement, CODEOWNERS gating for commercially relevant paths, and updated both CONTRIBUTING.md and HOW_TO_MONETIZE.md to reflect the CLA.

### Files Created

- `CLA.md` — Apache ICLA-style license grant (31 lines, 7 sections)
- `.github/workflows/ci.cla.yml` — CLA enforcement via contributor-assistant/github-action@v2
- `.github/CODEOWNERS` — Gates `apps/api/`, `packages/sync/`, `packages/sync-client/` for @braden-w review

### Files Modified

- `CONTRIBUTING.md` — Added "Licensing and CLA" section before Philosophy
- `HOW_TO_MONETIZE.md` — Updated "The short version" (removed "we don't need a CLA right now"), renamed "Why not a CLA?" to "The CLA", added CLA acknowledgment to comps section

### Deviations from Spec

- Workflow named `ci.cla.yml` instead of `cla.yml` — follows the repo's established `ci.` prefix convention for PR check workflows

### Follow-up Work

- Retroactive outreach to ~30 existing contributors (see Retroactive Outreach Plan section above)
- Create initial `signatures/cla.json` on first contributor signature (the GitHub Action handles this automatically)
