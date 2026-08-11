# Ark Lens And Markdown Checkout

Status: In Progress. Decisions: [ADR-0234](../docs/adr/0234-the-ark-owns-living-pages-and-markdown-is-an-explicit-checkout.md), [ADR-0235](../docs/adr/0235-ark-collections-are-ordered-predicates-over-pages.md).

## Product sentence

The Ark owns living pages and collections in one Lens-backed Yjs document,
projects them into SQLite for queries, and offers Vault Markdown as a deliberate
checkout that can safely return edits through `ark push`.

## Final shape

```txt
ark.lens.json                 local interpretation
  namespace: so.theark
  tables: pages, collections

Ark Yjs document              authored source
  pages rows                  attributes plus prose documents
  collections rows            predicates plus outlet bindings

SQLite projection             rebuildable read model
  pages, collections

Vault Markdown checkout       local editing surface
  pages/<slug>.md
  .ark/checkout.json          local base and path mapping
```

Ark reaches this workspace through the ordinary Epicenter application API:

```ts
const ark = await open(arkLens, {
  document: 'workspace',
  principalId,
});
```

Epicenter owns this open, the Lens interpretation, the Yjs document, SQLite
projection, and read-only SQL. Ark owns every product meaning above those
primitives: page fields and prose, collection predicates, badge navigation,
Markdown checkout, and eventual outlet delivery.

## Value owners

| Value | Owner |
| --- | --- |
| Page title, subtitle, dates, tags, resonance, prose | Ark `pages` row |
| Collection name, order, predicate, outlet binding | Ark `collections` row |
| SQLite tables and query results | Ark projection |
| Local Markdown text before import | Markdown checkout |
| Last-exported base and page/path map | Local checkout manifest |
| Historical release and delivery facts | publishing model, redesigned after collection delivery exists |

## Backward path

### 1. Establish the Ark contract

Create the literal `so.theark` Lens and the first Ark application surface. Its
`pages` schema must name the current page fields and use the row document for
the body. Its `collections` schema must carry `name`, `sort_key`, `where_sql`,
and outlet bindings. Bind it to prove that a fresh Yjs document rebuilds the
declared SQLite tables.

### 2. Make collections executable

Validate a collection expression by preparing it only in the fixed `WHERE`
context over `pages AS page`. Expose one read that returns matching page rows;
it must not create a SQLite view or a membership table. Keep invalid collection
rows readable with their validation error. Implement fractional sort-key moves.
The lowest key and stable-id tie-break select the Ark's default collection; they
do not create a canonical collection or alter page membership. Render the
collections as an ordered left-to-right badge row whose selected badge is the
one collection currently shown.

The ordinary editor compiles described filters into the one stored `where_sql`
expression. The advanced editor changes that same value. Do not persist a second
filter AST. A predicate too expressive for the ordinary editor stays available
as advanced SQL and is never rewritten by the visual surface.

### 3. Build the Markdown checkout

Export an Ark page to canonical Markdown and record its row identity, path, and
base snapshot in local machine state. Parse a changed checkout into page fields
and prose. `status`, `diff`, `push`, `pull`, and `sync` are the complete first
surface: `sync` composes successful `push` and `pull`; it adds no reconciliation
branch of its own.

`push` performs a three-way comparison of exported base, local checkout, and
current Ark page. It imports a safe structured/prose patch or refuses with a
conflict. `pull` refuses a dirty checkout. No watcher silently imports or
overwrites Markdown.

### 4. Cut over the Vault

Import each current Vault page once into Ark, preserving its prose and known
fields. Export the first Markdown checkout. After the imported content and
checkout behavior pass review, delete the Markdown-first write path and the
facet-membership source path. Do not retain a dual reader, a background syncer,
or a compatibility mirror.

### 5. Rebuild publishing from collections

Replace facet-derived delivery with collection-derived outlet resolution. A
collection with no outlets only organizes the Ark; a collection with bindings
creates delivery work for a matching release. Retire account-bearing facets,
per-facet outlet obligations, and any inventory that exists only to support
them.

## Recognition tests

- Editing and pushing Markdown cannot erase an Ark edit made after its recorded
  checkout base.
- SQLite can be deleted and rebuilt with identical rows from the Yjs document.
- Moving a collection first changes the default selected badge without changing
  a page or its collection membership.
- An invalid collection predicate remains visible and cannot cause delivery.
- A page receives collection membership only by evaluating its current authored
  properties.
- After cutover, no code path treats Markdown frontmatter or a facet membership
  as the canonical tags, resonance, or distribution source.
