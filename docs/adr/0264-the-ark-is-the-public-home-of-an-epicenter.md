# 0264. The Ark is the public home of an Epicenter

- **Status:** Proposed
- **Date:** 2026-08-29
- **Amends:** [ADR-0234](0234-the-ark-owns-living-pages-and-markdown-is-an-explicit-checkout.md) at the product boundary: The Ark is the public home of an Epicenter, while the row and checkout mechanics remain provisional.
- **Relates:** [ADR-0235](0235-ark-collections-are-ordered-predicates-over-pages.md)

## Context

Epicenter and The Ark have been drifting between two interpretations: two
products that both own a person's work, or one personal universe and its public
form. The second interpretation better explains the existing writing surface,
where one living idea can be read, heard, or watched without becoming three
different works. It also gives a personal domain such as `bradenwong.com` a
clear role without making the domain or The Ark a second source of truth.

## Decision

**The Ark is the public home of an Epicenter.** An Epicenter is one person's
living personal universe; The Ark is the public experience that makes selected
authored work legible and inhabitable by others. A work may expose reading,
listening, and watching as alternate expressions of the same idea. The Ark is
therefore a public materialization, not a second canonical authored store and
not primarily a social feed.

The first public promise is a living current work. An author-controlled
publicization step makes a work available in The Ark; the exact storage,
domain-routing, revision-history, and social-interaction mechanisms remain
separate decisions.

## Consequences

- Epicenter and The Ark form one private-to-public continuum rather than two
  competing identities.
- `theark.so/<person>` and a personal domain such as `bradenwong.com` may be
  different entrances to the same public place; neither entrance creates a
  second canonical work.
- The public unit is a living authored idea with optional text, audio, and
  video renditions. Historical snapshots, release ledgers, and social mechanics
  are deliberately deferred.
- Collections may organize and expose public work, but collection design does
  not decide who owns the underlying authored work.
- The existing Ark storage and Markdown-checkout proposal must be reconsidered
  at its ownership boundary before implementation; its useful local editing
  workflow should not be allowed to create two writers.

## Considered alternatives

- **The Ark owns living pages separately from Epicenter.** Refused: it splits
  one person's personal universe into two sources and makes the public product
  compete with the system that gives it meaning.
- **The Ark is primarily a social network.** Refused as the starting definition:
  social interaction may surround public places, but a public place and its
  living work are the product's first promise.
- **Decide immutable historical snapshots now.** Deferred: no current product
  need requires that promise, so it should not shape the first public surface.
