# 0160. The Ark public plane is a plain Worker streaming EU R2 projections

- **Status:** Proposed
- **Date:** 2026-07-19

## Context

The Ark is the canonical public web home for approved Vault artifacts: frozen
authored expressions with permanent, truthful permalinks
(`https://theark.so/braden/<artifact-slug>`). The Vault's publishing ADRs
(its ADR-0059 and ADR-0064) settled the artifact semantics: one Markdown
artifact owns its web, narration, and short-video outputs; the web projection
renders through one constrained creator theme; pre-rendered HTML in object
storage is disposable and rebuildable; per-artifact HTML/CSS/JS is refused.
What did not exist was any hosted delivery decision: which account, which
worker shape, where generated projections live, and what capabilities the
public plane may hold. This ADR owns hosted deployment and storage only; the
Vault ADRs continue to own artifact and projection semantics.

## Decision

**The Ark's public plane is `apps/theark`: a plain Cloudflare Worker in the
Epicenter account that serves fixed deploy-time design assets from Workers
Static Assets and streams immutable artifact projections from a dedicated
EU-jurisdiction R2 bucket, `theark-projections`, that the publishing side
writes and the Worker only reads.**

Each concern has exactly one owner:

- **Static Assets** own fixed deploy-time design: the one theme stylesheet,
  favicon, and the home/not-found shells. They are never the artifact corpus:
  publishing must not redeploy the Worker, and short-video files can exceed
  the per-file asset limit. `html_handling` is `none` because the Worker owns
  canonical pretty URLs and the asset shells must stay fetchable at literal
  `.html` paths.
- **R2 owns generated projections** under one key contract: URL path
  `/<segments>` maps to `routes/<segments>/index.html` for pretty paths and
  to the literal `routes/<segments>` when the last segment has a file
  extension. Pages and per-artifact media (cover, short video) ship by
  writing objects; the Worker validates segments against a strict lowercase
  allowlist before any key is formed, streams bodies without buffering, and
  answers GET/HEAD with correct ETag, conditional, and Range behavior.
- **The Worker owns delivery policy only**: one cache policy
  (`public, max-age=300, must-revalidate`, since projection bytes are
  regenerable and never a second authored source), `no-store` for absence,
  and 308 trailing-slash canonicalization. The publisher owns bytes and
  content-type.
- **A future authenticated creator application** (Epicenter login, workspace
  access) is a separate deployable that publishes into the bucket. The public
  plane holds none of its capabilities now: no auth, billing, Postgres,
  Hyperdrive, Durable Objects, Epicenter blob-store bindings, or write
  routes.

The Worker is plain (`export default { fetch }`), not Hono: it has two route
families and zero shared middleware, so a framework would own nothing. The
repo already accepts this shape (`apps/posthog-reverse-proxy`).

EU jurisdiction is a bucket property, not Worker placement: the binding
declares `jurisdiction: "eu"` and the bucket must be created with
`--jurisdiction eu` (permanent at creation). The public edge reader gets no
smart placement.

The R2 binding is logically read-only: the code calls only `get` and `head`.
The binding itself still carries write capability. v1 accepts that residual,
because the alternatives (a second Worker as a read proxy, or fetching a
public bucket domain over HTTP) each add a moving part and a failure mode to
remove a capability that no code path exercises and code review can hold at
zero. If Cloudflare ships read-only R2 bindings, adopt them.

## Consequences

- A publication appears by writing R2 objects; the Worker never redeploys for
  content. Theme changes are Worker redeploys and propagate to every page
  within the cache TTL, because generated HTML references the stable
  `/assets/theark.css` URL rather than a hashed one.
- The strict segment allowlist means hostile paths die before touching R2,
  but it also constrains the publisher: identities, slugs, and file names
  must be lowercase-hyphenated ASCII. That matches the Vault's authored slug
  contract.
- The public plane cannot serve per-artifact interactive code, by
  construction; a genuinely interactive product needs its own boundary.
- The `theark.so` custom-domain route stays commented out until DNS is
  delegated to Cloudflare; until then deploys serve on `workers.dev`.
- Writes to the bucket are governed by review of this app plus the
  publisher's credentials, not by a platform-enforced read-only boundary.

## Considered alternatives

- **Hono.** Lost: no repeated route or middleware behavior exists for it to
  own; a dependency with zero earned value on a security-sensitive public
  surface.
- **Serve projections from Static Assets.** Lost: publishing would require a
  redeploy, and short videos can exceed the per-file asset limit.
- **A second Worker or public bucket domain to make reads
  platform-enforced.** Lost: adds an origin, a hop, and cache/config drift to
  eliminate a capability the code never uses; revisit only if the public
  plane ever grows request-derived writes.
- **Reuse `epicenter-blobs` or the Epicenter API Worker.** Lost: the public
  plane must not hold private-plane capabilities, and the private blob store
  is a different product boundary with different lifecycle and jurisdiction.
