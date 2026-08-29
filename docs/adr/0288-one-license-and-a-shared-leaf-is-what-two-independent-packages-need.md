# 0288. One license, and a shared leaf is what two independent packages need

- **Status:** Accepted
- **Date:** 2026-08-29
- **Supersedes:** the MIT tier described in `docs/licensing/licensing-strategy.md`. That document is rewritten rather than deleted: its threat model, contributor posture, prior art, and proprietary template all survive, and the procedure for reintroducing MIT is recorded there.
- **Relates:** [ADR-0197](0197-one-sqlite-file-per-app-and-the-driver-contract-is-a-package.md) and [ADR-0247](0247-matter-owns-its-own-file-lifecycle.md), which record a deliberate relicensing and its reversal.

## Context

Epicenter had two license tiers: MIT for an embeddable toolkit, AGPL for
everything else, with a mechanical closure rule that whatever an MIT root
depended on had to be MIT too. `bun run check:licenses` enforced the closure on
dependency edges.

An inventory of the whole tree found the tier was not serving its purpose and
had begun to cost something real.

- **No embedder arrived.** `@epicenter/data`, the toolkit root the strategy was
  written around, was never published. Neither were `agent`, `agent-protocol`,
  `chat`, or `sqlite`. What reached npm was the closure the rule swept in
  (`field`, `identity`, `sync`) plus a `ui` that was `"license": "MIT"` and
  `"private": true` at once, so it was given away and offered to nobody
  simultaneously. Download counts sat at registry-bot noise.
- **Five of nine MIT packages had no MIT consumer**, including the two largest.
  `packages/ui` (11k lines) was imported by 177 files, every one AGPL.
- **It moved code.** `AuthState` sat in MIT `packages/identity` under a
  docstring explaining that it lived there so the MIT workspace and the AGPL
  auth client could share one definition across the firewall. Every consumer
  was AGPL, and the `packages/workspace` the docstring named as the other
  sharer had not existed for months.
- **Its registry went stale silently**, which the strategy document had
  predicted about itself in its own text: the roster said "exactly ten
  packages, which is what `bun run check:licenses` reports" while the script
  reported nine, and the root `LICENSE` named five packages and two apps that
  do not exist.

## Decision

**Everything under `packages/` and `apps/` is AGPL-3.0-or-later.**

- The root `LICENSE` is **generated** by reading every `package.json`, so the
  index cannot disagree with the packages by hand-editing drift. The
  hand-maintained per-package table in the strategy document is deleted for the
  same reason.
- `bun run check:licenses` is **kept**. It reports zero permissive packages and
  passes trivially, and it re-arms the moment one is reintroduced. Verified by
  marking `packages/data` MIT again: it fails on `data -> sync`, correctly.
- **Versions already published under MIT remain MIT for those versions,
  permanently.** `@epicenter/field@0.3.0`, `@epicenter/identity@0.3.0`,
  `@epicenter/sync@0.1.0`/`0.3.0`, and `@epicenter/ui@0.1.0`/`0.3.0`. The root
  `LICENSE` records this rather than implying otherwise.
- Reintroducing MIT requires a **named embedder**, not an intention to have
  one, and relicensing the root together with its whole closure. The procedure
  is in the strategy document.

**And a shared leaf is what two independent packages need.**

The firewall was the stated reason for several package boundaries, so removing
it invites dissolving them. Two are dissolved and two are kept, on one test:
**does either package depend on the other?**

- `@epicenter/identity` is **dissolved**, because it failed the test in a
  different way: it held two unrelated things. `AuthState` moves to
  `@epicenter/auth`, where every consumer already was. `PrincipalId`,
  `asPrincipalId`, and `INSTANCE_PRINCIPAL_ID` stay in a leaf renamed
  `@epicenter/principal`.
- `@epicenter/principal` **survives as a leaf**, against a recommendation to
  fold it into `@epicenter/data`. `data` and `auth` are siblings: neither
  declares the other, the store opens a local database with no auth
  (`openLocal`), and the auth client runs with no store (the hosted dashboard).
  Folding the branded id either way makes one sibling depend on the other for
  a string.
- `@epicenter/sync` **survives**, against a recommendation to fold it into
  `@epicenter/data/sync`. Its subprotocol vocabulary is spoken by three
  packages: `auth` constructs the denial and carries the bearer, `data`
  classifies the denial and dials the route, `server` parses the bearer and
  mounts the route. Folding it into the store would make the credential library
  import the store for a bearer constant.
- `@epicenter/agent-protocol` **survives** for the same reason: `agent` (the
  loop) and `client` (the engine) import it and not each other.

The firewall explained why those packages were MIT. It did not explain why they
existed, and the two questions were being answered as one.

## Consequences

- `packages/svelte-utils` is renamed `packages/svelte`, ending a directory that
  disagreed with the package it published.
- `@epicenter/svelte/auth` becomes `@epicenter/auth/svelte`. The strategy
  document had already specified this relocation, waiting on a trigger that
  said the barrel would go MIT; the trigger fired in the opposite direction.
- The Tauri deep-link OAuth chain is deleted: two files with no live consumer,
  which also removes three unused Tauri peer dependencies from each of
  `@epicenter/auth` and `@epicenter/svelte`. Recoverable from git if a
  standalone Tauri build ever wants it (ADR-0078), which the host-brokered
  credentials of ADR-0227 made moot.
- Declared-but-unimported dependency edges are dropped where they are inert.
  `apps/epicenter`'s edges on `honeycrisp` and `whispering` are **kept**: they
  have no source imports but encode a real build relationship
  (`bun run --cwd ../honeycrisp build:epicenter`).
- `check:licenses` still cannot see source **copied** across a boundary, which
  is the failure mode ADR-0197 and ADR-0247 both recorded by hand. With one
  tier there is nothing to copy across, and that is the honest reason the
  hazard is gone rather than mitigated.

## Considered alternatives

- **Keep the tier and fix its defects.** Correct on the merits if an embedder
  were plausible soon. Refused because the defects were symptoms: a boundary
  nobody crosses goes stale because nothing exercises it.
- **Collapse the packages the firewall explained.** Refused for `principal`,
  `sync`, and `agent-protocol` by the sibling test above. A package count is
  not the goal.
- **Delete `check:licenses`.** Refused. A guard that currently passes trivially
  is the difference between reintroducing MIT correctly and reintroducing it
  and finding out later.
