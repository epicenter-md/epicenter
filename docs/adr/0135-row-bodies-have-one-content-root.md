# 0135. Row bodies have one `content` root

- **Status:** Proposed
- **Date:** 2026-07-16
- **Amends:** [ADR-0106](0106-a-child-doc-body-owns-one-layout-the-polymorphic-timeline-is-refused-until-a-product-earns-it.md) and [ADR-0107](0107-a-child-doc-text-body-is-a-plain-y-text-the-timeline-array-is-deleted.md) only for the permanent row-body root layout
- **Relates:** [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-bodies-and-a-release-local-kv-lens.md), [ADR-0131](0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md), [ADR-0133](0133-row-bodies-are-sequence-addressed-update-logs-in-the-record-authority.md), [ADR-0134](0134-replicas-store-confirmed-state-and-compacted-row-intents.md)

## Context

Selecting a text or rich-text layout per table makes body format a permanent
table contract. That requires declarations, authority pins, admission checks,
ordered contract outcomes, replica metadata, baseline-acquisition sections, and
migration rules. Giving every body separate text and rich-text roots avoids negotiation,
but preserves two canonical values and forces applications to decide whether
they are related.

[Yjs 14 release candidates](https://github.com/yjs/yjs/releases/tag/v14.0.0-rc.24)
replace the older separate `Y.Text` and `Y.XmlFragment` class surface with one
[unified shared type](https://github.com/yjs/yjs/blob/v14.0.0-rc.24/src/index.js).
The v14 [CodeMirror binding](https://github.com/yjs/y-codemirror.next/blob/6a981e1794b3592a94f3d3b4fc620f14c5adaf11/src/index.js)
and [ProseMirror binding](https://github.com/yjs/y-prosemirror/blob/8c93eb5e1da4704200f87bbf5722b70eb69fba16/ARCHITECTURE.md)
both accept that shared type and interpret its delta for their editor model.
Epicenter therefore does not need to encode the editor choice into the durable
body layout.

## Decision

Every ordinary row has one latent Yjs document with exactly one supported
top-level root:

```txt
content  the row's one collaborative value
```

The root key is permanently the exact string `content`. The workspace exposes
one `RowBody` handle whose `binding` is the real Yjs v14 `Type`. The application
chooses the CodeMirror, ProseMirror, or other supported binding that interprets
that value. The workspace exposes no text handle, rich-text handle, live
document accessor, generic root lookup, active format, or body-kind marker.

The unified runtime type does not make editor data models interchangeable.
CodeMirror treats the delta as linear text; ProseMirror treats it as a
structured tree. An application chooses one interpretation for a body lifetime.
Changing that interpretation for populated content is an application-owned
conversion and replacement, not a binding toggle supplied by Epicenter.

One body represents one canonical collaborative value. An application may
explicitly replace or transform that value, but Epicenter does not preserve a
linear source and a structured tree as independently edited siblings. A product
that needs two independently authored values models two rows or stores the
second value in an application-owned representation.

There is no body declaration on `defineTable`, no per-table body kind, and no
authority body-contract map. An empty body persists no body row. One opaque
body update affects `content`; the authority neither interprets nor validates
the root.

The supported-root restriction is an API contract, not an adversarial byte
validation boundary. A shared-type binding has a document backpointer, so a
consumer can reach through it, and a raw Yjs client can manufacture other
roots. The schema-blind authority deliberately does not hydrate updates to
reject them. Unknown roots are unsupported opaque baggage and receive no
workspace accessor or compatibility promise. Replicas preserve and round-trip
those bytes; they do not reject an otherwise valid update merely because it
contains an unsupported root.

The root name carries no version prefix. Yjs dependency and update-encoding
compatibility belong to the workspace protocol major. This greenfield runtime
selects Yjs 14 and pins an exact release-candidate version until the stable
release is adopted deliberately. A future incompatible encoding change updates
the protocol and storage major; it does not create `v2:content` beside the old
root.

The application owning a table owns the interpretation of `content`. Epicenter
provides the collaborative slot and binding target, not a universal ProseMirror
schema, Markdown contract, cross-application document format, or conversion
pipeline. A product that needs interoperability must earn and own it above the
workspace layer.

## Consequences

- The body declaration API, contract identifiers, authority contract pins,
  contract protocol entries, contract tables, and contract baseline-acquisition
  sections disappear.
- The separate `TextBody` and `RichTextBody` handles, dual-root hydration, and
  questions about which value is canonical disappear.
- Direct `Y.Doc` accessors, generic roots, automatic conversion, active-body
  modes, and version-prefixed roots remain refused. Reach-through from a real
  editor binding is possible but unsupported.
- Every ordinary row is body-capable at no storage cost while empty. The
  reserved workspace KV record remains scalar-only.
- Two releases can still disagree about how an application's content is
  interpreted. That is an application compatibility error, not sync admission
  or a platform migration system.
- Adopting a release candidate accepts upstream API churn before Yjs 14 stable.
  Exact dependency pinning contains that risk without preserving a Yjs 13 path.

## Considered alternatives

- **Pin one body contract per table.** Rejected because a universal fixed body
  makes negotiation and its durable metadata unnecessary.
- **Expose only a raw Yjs document.** Rejected because it discards the permanent
  acquisition names and invites every consumer to invent a layout. Real shared
  types remain available through the body binding for editor integration.
- **Keep separate `text` and `richText` roots.** Rejected because one row body
  should not silently become two independently authored documents. Yjs 14 lets
  the application binding interpret one shared type directly.
- **Name the root `text`, `richText`, `xml`, or `document`.** Rejected because
  those names freeze one application interpretation into the durable layout.
- **Prefix roots with `v1`.** Rejected because it makes encoding evolution a
  permanent content namespace and invites parallel roots and fallback readers.
