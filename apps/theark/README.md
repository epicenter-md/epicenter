# The Ark public delivery plane

`theark` is the Worker behind `https://theark.so`. It serves exactly two kinds
of content:

1. **Fixed deploy-time design assets** from Workers Static Assets (`public/`):
   the one constrained reading theme (`/assets/theark.css`), the favicon, and
   the home and not-found shells. Changing the theme is a redeploy of this
   Worker.
2. **Immutable public artifact projections** streamed from the
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
| `/<pretty>[/<pretty>...]` | R2 `routes/<path>/index.html`, as a page |
| `/<pretty>/.../<file.ext>` | R2 `routes/<path>`, as an immutable asset (video, cover image) |

A pretty segment matches `[a-z0-9]+(-[a-z0-9]+)*`; a file segment adds
dot-separated extensions and is only valid as the last segment. Anything else
is 404 before R2 is consulted. Trailing slashes 308-redirect to the slashless
form. Only GET and HEAD are allowed. Range, `If-None-Match`/`If-Match`, and
HEAD behave per HTTP so short-video files stream correctly.

Delivery policy is Worker-owned: every projection is served with
`cache-control: public, max-age=300, must-revalidate` (bytes at a key are
regenerable, so nothing is `immutable`), and missing objects are `no-store`
so a new publication is visible immediately.

This Worker deliberately has **no** auth, billing, Postgres, Durable Objects,
Epicenter blob-store access, write routes, or renderer plugins. A future
authenticated creator application publishes *into* the bucket; it does not
live here.

## Develop

```bash
bun run --cwd apps/theark test        # fetch-handler tests (bun test)
bun run --cwd apps/theark typecheck
bun run --cwd apps/theark typegen     # regenerate worker-configuration.d.ts after wrangler.jsonc changes
bun dev:theark                        # wrangler dev (see note below)
```

Note: the repo's pinned wrangler (4.80.0) bundles a workerd older than this
app's compatibility date, so `wrangler dev` and `wrangler check startup` fail
locally with a runtime-start error until the catalog wrangler is bumped.
`wrangler types`, `bun test`, `typecheck`, and `wrangler deploy --dry-run`
are unaffected, and real deploys validate the date server-side.

## Deploy prerequisites (external actions, in order)

1. Create the EU-jurisdiction bucket (jurisdiction is permanent; the bucket
   must not be created without it):
   `bun x wrangler r2 bucket create theark-projections --jurisdiction eu`
2. Delegate `theark.so` DNS to Cloudflare (today it sits on registrar
   nameservers), then uncomment the `routes` block in `wrangler.jsonc`.
3. `bun run --cwd apps/theark deploy`

Until DNS is delegated, the Worker can deploy without the route and serve on
its `workers.dev` URL.
