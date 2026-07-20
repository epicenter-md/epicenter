# The Ark public delivery plane

`theark` is the Worker behind `https://theark.so`. It serves exactly two kinds
of content:

1. **Fixed deploy-time design assets** from Workers Static Assets (`public/`):
   the one constrained reading theme (`/assets/theark.css`), the favicon, and
   the home and not-found shells. Changing the theme is a redeploy of this
   Worker.
2. **Rebuildable public artifact projections** streamed from the
   `theark-projections` R2 bucket (EU jurisdiction). The publishing side (the
   Vault) writes projection objects; a publication appears by writing R2 keys,
   never by redeploying this Worker.

The artifact and projection semantics (frozen expressions, truthful
permalinks, one constrained theme, insert identity) are owned by the Vault's
publishing ADRs, notably ADR-0059 and ADR-0064 in that repo. This app owns
only hosted delivery; see `docs/adr/0160-the-ark-public-plane-is-a-plain-worker-streaming-eu-r2-projections.md`.

## URL and key contract

Canonical artifact permalinks are `https://theark.so/braden/<artifact-slug>`.

| URL | Serves |
| --- | --- |
| `/` | `public/home.html` (deploy-time shell) |
| `/assets/theark.css`, `/favicon.svg` | Static Assets, literal paths |
| `/<identity>` | R2 `<identity>/index.html`, as a person route |
| `/<identity>/<slug-or-facet>` | R2 `<identity>/<slug-or-facet>/index.html`, as an artifact permalink or facet route |
| `/<identity>/<artifact-slug>/<file.ext>` | R2 `<identity>/<artifact-slug>/<file.ext>`, as generated media belonging to that expression |

A human-readable page route has one or two lowercase-hyphenated segments. An
artifact's generated files live directly beneath its permanent permalink, so
the public URL tree and R2 tree say the same thing. Because the canonical page
URL is slashless, generated HTML must use root-absolute media URLs such as
`/braden/<slug>/video.mp4`; a bare `video.mp4` would resolve outside the artifact
subtree. Explicit `index.html` aliases, percent-encoded aliases, the reserved
`/assets` identity, and anything outside these exact families are 404 before R2
is consulted. Trailing slashes 308-redirect to the slashless form. Only GET and
HEAD are allowed. Cloudflare Workers Caching owns byte-range delivery from the
Worker's full streamed responses; conditional reads and HEAD remain Worker/R2
behavior.

Delivery policy is Worker-owned: every projection is served with
`cache-control: public, max-age=300, must-revalidate` (bytes at a key are
regenerable, so nothing is `immutable`), and missing objects are `no-store`
so a new publication is visible immediately. The Worker also applies a CSP that
refuses executable per-artifact code while allowing the shared stylesheet,
images, fonts, and media.

The second path segment is one shared publisher-owned namespace: a facet and an
artifact cannot both own `/braden/codes`. The publisher kernel (below) refuses
cross-owner collisions, reserves a route forever to its first artifact owner,
writes media first, and activates `index.html` last. The delivery Worker
deliberately has no route registry.

This Worker deliberately has **no** auth, billing, Postgres, Durable Objects,
Epicenter blob-store access, write routes, or renderer plugins.

## Publishing side: renderer and kernel

The trusted publishing code lives beside the delivery Worker as library
modules the Worker entry never imports, so the deployed public plane keeps
zero write paths (see the ADR-0160 amendment):

- `src/render.ts` is the constrained renderer: one pure, total function from a
  frozen-artifact-shaped input to one complete semantic HTML document. It
  emits no JavaScript and references only `/assets/theark.css` plus
  root-absolute sibling media. Its explicit Markdown subset is documented in
  the module header; everything outside the subset (raw HTML, executable URL
  schemes, tables, deeper headings, foreign images) renders as visibly
  escaped literal text. It never throws: Publish freezes the artifact before
  projecting it, and projection HTML is disposable, so degraded output is
  always recoverable by a renderer improvement plus a rebuild.
- `src/publish.ts` is the publisher kernel: given an injected R2-shaped
  object store, it reserves the `<identity>/<slug>` subtree with a
  publicly-unroutable `.artifact` ownership marker (dotfiles fail the public
  route allowlist by construction), writes generated media
  (`video.mp4`/`narration.mp3`/`cover.png`, the complete media vocabulary),
  renders and activates `index.html` last, and read-back-verifies every
  object. Republish by the same artifact converges idempotently; any other
  artifact is refused the slug forever. Keys are derived through the delivery
  Worker's own `resolveProjection`, so the kernel cannot write an address the
  Worker would refuse to serve.

The kernel runs wherever an authenticated caller holds bucket credentials: an
operator CLI first, the Vault's injected `ArkPublisher` port behind it. That
caller must supply the page `title` and receipt `publishedOn`, which the
Vault port does not carry, and owns public-URL verification against the
expected canonical URL.

## Develop

```bash
bun run --cwd apps/theark test        # fetch-handler tests (bun test)
bun run --cwd apps/theark typecheck
bun run --cwd apps/theark typegen     # regenerate worker-configuration.d.ts after wrangler.jsonc changes
bun dev:theark                        # wrangler dev (see note below)
```

## Deploy prerequisites (external actions, in order)

1. Create the EU-jurisdiction bucket (jurisdiction is permanent; the bucket
   must not be created without it):
   `bun x wrangler r2 bucket create theark-projections --jurisdiction eu`
2. Delegate `theark.so` DNS to Cloudflare (today it sits on registrar
   nameservers), then uncomment the `routes` block in `wrangler.jsonc`.
3. `bun run --cwd apps/theark deploy`

Until DNS is delegated, the Worker can deploy without the route and serve on
its `workers.dev` URL.
