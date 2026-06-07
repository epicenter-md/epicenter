/**
 * The workspace's substrate-only value builder: what `defineTable` column and `defineKv`
 * value authoring add on top of the shared `field.*` vocabulary (`@epicenter/field`).
 *
 * The portable kinds (`field.string`, `field.select`, `field.datetime`, `field.json`, ...)
 * come straight from the leaf and are authored as `field.*`. This module holds the one
 * builder the closed vocabulary deliberately OMITS, because it is a per-substrate decision
 * rather than a member of the shared field set:
 *
 * - `nullable(inner)` — `Type.Union([inner, Type.Null()])`, the emptiness AXIS. A CRDT row
 *   has a fixed shape and cannot omit a key, so emptiness is a `null` VALUE (matter, whose
 *   markdown substrate encodes emptiness as an ABSENT key, forbids it). It is not a kind:
 *   `recognize` returns null for a nullable wrapper, so it degrades to raw cross-substrate.
 *
 * Exported standalone (re-exported from `@epicenter/workspace`), so apps author `field.*`
 * for the kinds and `nullable` for the substrate policy, with no `column` namespace.
 * `nullable` wraps any workspace VALUE schema, a `defineTable` column OR a `defineKv` value
 * (both are fixed-shape CRDT entries that encode emptiness as `null`); the `FlatJsonTSchema`
 * constraint (in `./column/constraint`) is narrower, gating only `defineTable` columns, whether
 * authored via `field.*`, `nullable`, or raw `Type.*`. A branded format like an IANA
 * timezone is just `field.string<IanaTimeZone>()`: the brand carries the type, no bespoke
 * builder required.
 */

import { type TNull, type TSchema, type TUnion, Type } from 'typebox';

/**
 * The emptiness AXIS: `Type.Union([schema, Type.Null()])`, reading as "nullable inner"
 * instead of constructing the union by hand (TypeBox issue #989). This is the workspace's
 * substrate policy, NOT a field kind: a CRDT row (and likewise a `defineKv` value) has a
 * fixed shape and cannot omit a key, so emptiness is encoded as a `null` VALUE (matter,
 * whose markdown substrate encodes emptiness as an ABSENT key, forbids it). Exported
 * standalone so apps author it alongside `field.*` without the `column` namespace.
 */
export function nullable<S extends TSchema>(schema: S): TUnion<[S, TNull]> {
	return Type.Union([schema, Type.Null()]);
}
