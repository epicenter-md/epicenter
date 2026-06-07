/**
 * The contract every per-kind Field component implements.
 *
 * A Field renders AND edits one cell whose value is in its kind's domain (`OK`)
 * or empty (`NEEDS_VALUE`). It NEVER handles `INVALID`: an out-of-domain
 * value cannot fit a typed widget, so the {@link ModeledCell} wrapper routes those
 * to the universal JSON repair editor before a Field is ever chosen. Kind dispatch
 * is gated behind validity, so a Field only ever sees a value it can represent.
 *
 * A Field's one job is to COMMIT a value in its kind's domain (including the empty
 * but present values `""` and `[]`); it never deletes the key. Deleting the key
 * (clearing the cell back to NEEDS_VALUE) is shared cell chrome owned by
 * {@link ModeledCell}, the same control for every kind, so no Field decides if or
 * how to expose a clear affordance.
 *
 * A Field owns its own open/editing local state (the keystroke-buffer island) and
 * writes through {@link SaveField}; it never mutates the projection. The vault
 * reclassifies the row from the written bytes (and the watcher re-confirms it), so
 * a value that leaves the kind's domain reappears as INVALID (handled by the
 * wrapper, not the Field).
 */

import type { NeedsValueCell, OkCell } from '$lib/core/conformance';
import type { Field } from '@epicenter/field';

/**
 * Commit a new value for this cell's field. The {@link ModeledCell} wrapper binds
 * the row name and field key; a Field supplies only the value. There is no clear
 * counterpart in a Field's props: deleting the key is the wrapper's shared chrome,
 * never `save(undefined)` from a widget.
 */
export type SaveField = (value: unknown) => void;

/**
 * The cells a per-kind Field renders: a conformant {@link OkCell} or an empty
 * {@link NeedsValueCell}, both for field variant `F`. The invalid state is routed to the
 * JSON repair editor by {@link ModeledCell} before a Field is chosen, so a Field never
 * receives it. Composed UP from the two renderable members, not subtracted from the full
 * `Cell` union, so the set the widgets handle is stated directly. `F` defaults to the
 * full {@link Field} union; a per-kind widget pins it (e.g. `FieldOf<'select'>`) so its
 * `cell.field.schema` is the precise shape, not the union.
 */
export type RenderableCell<F = Field> = OkCell<F> | NeedsValueCell<F>;

/**
 * Props a per-kind Field component receives. `F` defaults to the full {@link Field}
 * union, which is what MOST widgets take: they read only `cell.state` / `cell.value` /
 * `save` (and `cell.field.name`), none of which depend on the kind. A widget
 * pins `F` to its own kind (`FieldProps<FieldOf<'select'>>`) ONLY when its body reads
 * that kind's SCHEMA, so `cell.field.schema` is the precise shape with no `optionsOf`
 * and no cast (the schema readers are SelectField on `schema.enum` and MultiSelectField
 * on `schema.items.enum`). So a pinned `F` is a signal: this widget reads its schema.
 * `save` is identical for every kind, so only `cell` varies.
 */
export type FieldProps<F = Field> = {
	/** The classified cell to render: `OK` (carries a value) or `NEEDS_VALUE` (empty). */
	cell: RenderableCell<F>;
	/** Commit a new value for the field. */
	save: SaveField;
};
