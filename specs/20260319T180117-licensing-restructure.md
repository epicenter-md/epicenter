# Licensing Restructure: Split Licensing and CLA Removal

## What changed

We went deep on licensing strategy and concluded that the current approach (full AGPL + CLA + dual-licensing) is wrong for Epicenter. The CLA tooling ecosystem is dead (every option is semi-abandoned), dual-licensing is a dying model, and full AGPL on the library packages kills adoption.

The new model follows Liveblocks: MIT client libraries for maximum ecosystem adoption, AGPL sync server to protect hosting revenue, no CLA, no dual licensing. Revenue comes from hosted sync and enterprise features. Not from selling AGPL exemptions.

This spec supersedes:
- `specs/20260313T071500-add-cla-infrastructure.md` (CLA is being removed)
- `specs/20251114T042734 mit-to-agpl-migration.md` (AGPL stays on server/sync, but packages move to MIT)
- PR #1540 (CLA bot version pin. Now obsolete, the entire CLA workflow is being removed)

## The model

Liveblocks does exactly this. Their root LICENSE file:

```
1. Most of the code → Apache License 2.0
2. packages/liveblocks-server → AGPL-3.0
```

Ours:

```
MIT (maximum adoption. Npm install freely):
  packages/workspace/        Core CRDT library
  packages/ui/               UI components
  packages/svelte-utils/     Svelte utilities
  packages/constants/        Shared constants
  packages/ai/               AI utilities
  packages/cli/              CLI tool
  packages/filesystem/       Filesystem abstraction
  packages/vault/            Vault/encryption
  packages/sync-client/      Sync client library
  apps/whispering/           Desktop transcription app
  apps/tab-manager/          Chrome extension
  apps/tab-manager-markdown/ Markdown export for tabs
  apps/fuji/                 Fuji app
  apps/honeycrisp/           Honeycrisp app
  apps/opensidian/           File explorer app
  apps/landing/              Landing page

AGPL-3.0 (protects sync server and hosting revenue):
  apps/api/                  Sync/relay server (Cloudflare Workers + DOs)
  packages/sync/             Sync protocol library
```

The sync layer is AGPL because that's the commercially relevant infrastructure. The thing customers would self-host. Everything else is MIT because it's the library/app layer that developers interact with, and maximum adoption matters more than copyleft protection there.

## Why not keep the CLA

Three reasons:

1. We don't need dual licensing. The Bitwarden/Liveblocks open-core model (AGPL base + proprietary enterprise features) achieves the same business outcome without needing to relicense external contributions. Enterprise features will be written 100% by the team.

2. The CLA tooling is all broken. `contributor-assistant/github-action` is Alpha, last release Sept 2024. `cla-assistant.io` has users reporting they can't sign CLAs, zero maintainer response, last commit Oct 2023. There's nothing else.

3. CLAs add friction for zero benefit in our model. External contributions go into the MIT or AGPL layers. The future proprietary enterprise layer (`epicenter_license/`) will be team-written only. External contributors never touch it.

## Why the sync layer stays AGPL

The sync server and protocol are the commercially relevant code. AGPL means: if someone hosts a modified version and serves users, they must publish their modifications. This prevents a competitor from taking the sync server, adding proprietary features, and offering "Epicenter Cloud" without contributing back. It's the same reason Liveblocks AGPLs their server package.

The sync client (`packages/sync-client/`) is MIT because it's the package app developers import to connect to the sync server. Making it MIT means developers can build proprietary apps that sync via Epicenter Cloud without AGPL contamination on their app code. Matching how Liveblocks makes their client packages Apache.

## Revenue model (updated from HOW_TO_MONETIZE.md)

The old doc described dual licensing. The new model is open core + hosted sync:

**Epicenter Cloud** (hosted sync): customers pay for managed sync infrastructure instead of running their own AGPL server. This is the primary revenue stream, same as how Supabase sells hosted Postgres and Liveblocks sells hosted collaboration.

**Enterprise features** (future, proprietary): team management, SSO, admin dashboard, audit logging, advanced sync controls. These live in a separate `epicenter_license/` directory under a proprietary source-available license. Written entirely by the team, no external contributions, no CLA needed.

**Support contracts**: SLA-backed support for organizations that self-host the AGPL server.

The AGPL sync server is free to self-host. Customers who want to avoid infrastructure complexity pay for Epicenter Cloud. Customers who want enterprise features pay for those features. Nobody pays for an "AGPL exemption."

## What changes (file by file)

### Delete

| File | Why |
|---|---|
| `.github/workflows/ci.cla.yml` | CLA enforcement removed entirely |
| `CLA.md` | No longer requiring a CLA |
| `signatures/cla.json` | CLA signature storage no longer needed |

### Rewrite

| File | What changes |
|---|---|
| `HOW_TO_MONETIZE.md` | Complete rewrite. Replace dual-licensing language with open-core model. Describe the split licensing (MIT packages + AGPL sync), Epicenter Cloud as primary revenue, enterprise features as secondary. Reference Liveblocks and Bitwarden as the actual comps (not Cal.com/dub.sh. They don't dual-license). Follow the writing-voice skill: no pitch-deck language, no dollar figures, lead with the point. |
| `CONTRIBUTING.md` | Remove the entire "Licensing and CLA" section (lines 249-255). Replace with a simpler note explaining the split: packages are MIT, sync layer is AGPL, contributions to either are welcome under those respective licenses. No CLA mention. |
| `README.md` | Update the license section at the bottom. Currently says `[AGPL-3.0](LICENSE)`. Change to explain the split briefly: "The library packages are MIT. The sync server is AGPL-3.0. See [LICENSE](LICENSE) for details." |

### Create

| File | Content |
|---|---|
| `LICENSE` (root, replace) | Composite license file modeled on Liveblocks. Explains that most code is MIT, sync layer is AGPL-3.0, and points to per-directory LICENSE files. |
| `licenses/LICENSE-MIT` | Standard MIT license text, copyright Braden Wong |
| `licenses/LICENSE-AGPL-3.0` | Full AGPL-3.0 text (move current root LICENSE here) |
| `packages/workspace/LICENSE` | MIT (symlink or copy, referencing `../../licenses/LICENSE-MIT`) |
| `packages/ui/LICENSE` | MIT |
| `packages/svelte-utils/LICENSE` | MIT |
| `packages/constants/LICENSE` | MIT |
| `packages/ai/LICENSE` | MIT |
| `packages/cli/LICENSE` | MIT |
| `packages/filesystem/LICENSE` | MIT |
| `packages/vault/LICENSE` | MIT |
| `packages/sync/LICENSE` | AGPL-3.0 |
| `packages/sync-client/LICENSE` | MIT |
| `apps/api/LICENSE` | AGPL-3.0 |
| All other `apps/*/LICENSE` | MIT |

### Update

| File | What changes |
|---|---|
| `package.json` (root) | `"license": "SEE LICENSE IN LICENSE"`: npm convention for composite licenses. Forces readers to the root LICENSE file which explains the split. Does NOT override per-package license fields; each package.json has its own. |
| `packages/workspace/package.json` | `"license": "MIT"` |
| `packages/ui/package.json` | `"license": "MIT"` |
| `packages/svelte-utils/package.json` | `"license": "MIT"` |
| `packages/constants/package.json` | `"license": "MIT"` |
| `packages/ai/package.json` | `"license": "MIT"` |
| `packages/cli/package.json` | `"license": "MIT"` |
| `packages/filesystem/package.json` | `"license": "MIT"` |
| `packages/vault/package.json` | `"license": "MIT"` |
| `packages/sync/package.json` | `"license": "AGPL-3.0"` (already correct) |
| `packages/sync-client/package.json` | `"license": "MIT"` |
| `apps/api/package.json` | `"license": "AGPL-3.0"` (already correct) |
| All other `apps/*/package.json` | `"license": "MIT"` |
| `.github/CODEOWNERS` | Update comment from "dual-licensed commercially" to "AGPL-protected sync infrastructure" |
| `.github/workflows/README.md` | Remove the `ci.cla.yml` entry from the CI table. Add note that packages are MIT, sync is AGPL. |

## Todo

- [ ] 1. Create `licenses/` directory with `LICENSE-MIT` and `LICENSE-AGPL-3.0`
- [ ] 2. Rewrite root `LICENSE` as a composite file (Liveblocks-style) explaining the split
- [ ] 3. Add per-package `LICENSE` files (MIT for library packages, AGPL for sync)
- [ ] 4. Add per-app `LICENSE` files (MIT for all apps except api, AGPL for api)
- [ ] 5. Update all `package.json` license fields
- [ ] 6. Delete `.github/workflows/ci.cla.yml`
- [ ] 7. Delete `CLA.md`
- [ ] 8. Delete `signatures/cla.json` (if present)
- [ ] 9. Rewrite `HOW_TO_MONETIZE.md` for open-core model
- [ ] 10. Update `CONTRIBUTING.md`: remove CLA section, add split-license explanation
- [ ] 11. Update `README.md` license section
- [ ] 12. Update `.github/CODEOWNERS` comment
- [ ] 13. Update `.github/workflows/README.md`: remove CLA entry
- [ ] 14. Create PR referencing this spec, noting PR #1540 is superseded

## What this does NOT do

- Does not create the `epicenter_license/` directory or any proprietary feature code. That's a future task when enterprise features are actually built.
- Does not change any source code. This is purely licensing, docs, and CI.
- Does not retroactively relicense existing contributions. All past contributions were made under AGPL-3.0. Moving packages to MIT is more permissive, which is legally fine. MIT is a subset of what AGPL allows.
- Does not remove `.github/CODEOWNERS`. The sync code paths still need review gating.

## Comps and references

| Project | Model | Library License | Server License | CLA? |
|---|---|---|---|---|
| **Liveblocks** | Open core + hosted | Apache 2.0 | AGPL-3.0 | No |
| **Bitwarden** | Open core + enterprise features | GPL-3.0 (clients) | AGPL-3.0 (server) | No |
| **Yjs** | MIT everything, monetize hosting | MIT | MIT | No |
| **TipTap/Hocuspocus** | MIT everything, sell cloud | MIT | MIT | No |
| **Supabase** | Open core + hosted | Apache 2.0 | Apache 2.0 | No |
| **Grafana** | Open core + hosted | AGPL-3.0 | AGPL-3.0 | Yes (CLA) |

We follow the Liveblocks model most closely: MIT client libraries, AGPL server, no CLA, revenue from hosting + enterprise features.

## Resolved questions

1. **`packages/sync-client/` → MIT.** It's what app developers import to connect to the sync server. Liveblocks makes their client packages Apache for the same reason. You want developers building proprietary apps on your platform, not scaring them away with AGPL contamination.

2. **`packages/filesystem/` and `packages/vault/` → MIT.** Adoption matters more than protecting encryption logic. The commercially valuable part is the hosted infrastructure, not the client-side encryption code.

3. **Root `package.json` → `"SEE LICENSE IN LICENSE"`.** The npm convention for composite licenses. Each nested package.json has its own license field that takes precedence for that package. The root field just signals "it's complicated, read the LICENSE file."

## Review

_To be filled after implementation._
