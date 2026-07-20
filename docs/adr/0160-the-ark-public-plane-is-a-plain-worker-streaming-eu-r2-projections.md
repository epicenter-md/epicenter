# 0160. The Ark public plane is a plain Worker streaming EU R2 projections

- **Status:** Accepted
- **Date:** 2026-07-19

## Context

The Ark is the canonical public web home for frozen Vault artifacts: exact
authored expressions whose Publish was pressed, with permanent, truthful permalinks
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
Static Assets and streams rebuildable artifact projections from a dedicated
EU-jurisdiction R2 bucket, `theark-projections`, that an authenticated Epicenter
publisher writes and the Worker only reads.**

Each concern has exactly one owner:

- **Static Assets** own fixed deploy-time design: the one theme stylesheet,
  favicon, and the home/not-found shells. They are never the artifact corpus:
  publishing must not redeploy the Worker, and short-video files can exceed
  the per-file asset limit. `html_handling` is `none` because the Worker owns
  canonical pretty URLs and the asset shells must stay fetchable at literal
  `.html` paths.
- **R2 owns one generated public subtree per expression.** Person, facet, and
  artifact pages map to `<identity>[/<slug-or-facet>]/index.html`; generated
  media lives beside its artifact page at
  `<identity>/<artifact-slug>/<file>`. The public path and object key therefore
  describe the same person and expression, and no internal artifact UUID leaks
  into the public product. Because canonical page URLs are slashless, the
  constrained renderer emits root-absolute media URLs under that subtree rather
  than bare relative filenames. Explicit `index.html` aliases are refused.
  Pages and media ship by writing objects; the Worker validates every path
  against these exact allowlists before any key is formed and streams bodies
  without buffering.
- **The Worker owns delivery policy only**: one cache policy
  (`public, max-age=300, must-revalidate`, since projection bytes are
  regenerable and never a second authored source), `no-store` for absence,
  308 trailing-slash canonicalization, and a CSP that refuses executable
  per-artifact code. Workers Caching serves Range requests from cached full
  responses, so the Worker carries no byte-range implementation. The publisher
  owns bytes and content-type.
- **A future authenticated creator application** (Epicenter login, workspace
  access) is a separate deployable that implements the Vault's injected
  publisher port. It renders the complete frozen artifact, writes media first,
  conditionally activates `index.html` last, verifies the canonical URL, and
  returns only after the projection is public. The public plane holds none of
  its capabilities now: no auth, billing, Postgres, Hyperdrive, Durable Objects,
  Epicenter blob-store bindings, or write routes.

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
- The strict route allowlist means hostile and percent-encoded alias paths die
  before touching R2. Public identities and slugs must be lowercase-hyphenated
  ASCII; `assets` is reserved for deploy-time static design. Artifact UUIDv7
  values remain private authored-row identities rather than a second public
  routing vocabulary.
- The second segment is one publisher-owned route namespace. Facets and
  artifacts cannot claim the same `(identity, segment)`. The publisher reserves
  first ownership, refuses cross-owner overwrites and duplicate media names,
  writes media first, and conditionally activates `index.html` last. The Worker
  remains ignorant of ownership. Rebuilds may replace bytes only for the same
  private artifact owner.
- The trusted constrained renderer plus the Worker's CSP refuse per-artifact
  interactive code; a genuinely interactive product needs its own boundary.
- The `theark.so` custom-domain route stays commented out until DNS is
  delegated to Cloudflare; until then deploys serve on `workers.dev`.
- Writes to the bucket are governed by review of this app plus the
  publisher's credentials, not by a platform-enforced read-only boundary.

## Considered alternatives

- **Hono.** Lost: no repeated route or middleware behavior exists for it to
  own; a dependency with zero earned value on a security-sensitive public
  surface.
- **Expose generated files through `/_artifacts/<uuidv7>/<file>`.** Lost: this
  creates a second public identity for one expression, leaks a private row ID,
  and makes future identity aliases govern two unrelated URL families. The
  permanent artifact permalink already gives every generated file a truthful
  home.
- **Serve projections from Static Assets.** Lost: publishing would require a
  redeploy, and short videos can exceed the per-file asset limit.
- **A second Worker or public bucket domain to make reads
  platform-enforced.** Lost: adds an origin, a hop, and cache/config drift to
  eliminate a capability the code never uses; revisit only if the public
  plane ever grows request-derived writes.
- **Reuse `epicenter-blobs` or the Epicenter API Worker.** Lost: the public
  plane must not hold private-plane capabilities, and the private blob store
  is a different product boundary with different lifecycle and jurisdiction.
