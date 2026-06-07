/**
 * The Kind -> Field component map: the UI layer's half of the contract whose
 * model half is `recognize` (schema -> Kind) in `@epicenter/field`. Keeping them separate
 * is the point: the model layer derives the kind and stays free of component imports;
 * this layer maps the kind to a widget.
 *
 * `satisfies Record<Kind, FieldComponent>` IS the exhaustiveness guarantee: add a
 * kind to the palette and this object fails to compile until its Field exists. A
 * missing kind is caught at the map literal, not at a render fallthrough. `number`
 * and `integer` share `NumericField`; `multiSelect` and `tags` are both string lists
 * but FORK their editors (a closed-enum combobox vs free chip entry), so each has its
 * own widget. `json` is the arbitrary-JSON kind (a JSON-text editor); the rejection
 * lane is now a recognize `null` (an unmarked shape outside the palette), not a missing
 * widget, so `Kind` is exactly the renderable set.
 */

import type { Component } from 'svelte';
import type { FieldOf, Kind } from '@epicenter/field';
import BooleanField from './BooleanField.svelte';
import DateTimeField from './DateTimeField.svelte';
import JsonField from './JsonField.svelte';
import MultiSelectField from './MultiSelectField.svelte';
import NumericField from './NumericField.svelte';
import SelectField from './SelectField.svelte';
import StringField from './StringField.svelte';
import TagsField from './TagsField.svelte';
import type { FieldProps } from './field-props';
import UrlField from './UrlField.svelte';

/** A per-kind Field widget over the base (full-union) props, the dispatch surface type. */
export type FieldComponent = Component<FieldProps>;

/**
 * The Kind -> widget map. Each widget is typed to ITS OWN kind's narrowed props, and
 * `satisfies { [K in Kind]: Component<FieldProps<FieldOf<K>>> }` checks that correlation:
 * a kind's widget must accept that kind's narrowed cell (so `SelectField` provably reads
 * a `select` schema), and adding a kind without its widget fails to compile. `number`
 * and `integer` share `NumericField`; `multiSelect` and `tags` fork (a closed-enum
 * combobox vs free chip entry), so each has its own widget. `json` is the arbitrary-JSON
 * kind; an unmarked shape outside the palette degrades to raw (recognize `null`), not here.
 */
const WIDGETS = {
	string: StringField,
	integer: NumericField,
	number: NumericField,
	boolean: BooleanField,
	datetime: DateTimeField,
	url: UrlField,
	select: SelectField,
	multiSelect: MultiSelectField,
	tags: TagsField,
	json: JsonField,
} satisfies { [K in Kind]: Component<FieldProps<FieldOf<K>>> };

/**
 * The dispatch surface. {@link ModeledCell} indexes this with `cell.field.kind`, so a
 * widget only ever receives a cell of its own kind, but TypeScript can't express that
 * runtime correlation (`WIDGETS[someKind]` is the union of all widgets, none of which
 * provably accepts an arbitrary cell). Widening the `satisfies`-checked map to the base
 * {@link FieldComponent} is the cast at the UI-DISPATCH boundary; the field pipeline has
 * exactly one other, `recognize`'s at the model boundary in `@epicenter/field`. It is sound by
 * the indexing invariant above, and every widget body stays narrow and cast-free.
 */
export const FIELD_COMPONENTS = WIDGETS as unknown as Record<Kind, FieldComponent>;
