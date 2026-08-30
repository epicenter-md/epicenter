/**
 * Compile-time pins for the refusals in `define.ts`.
 *
 * Each rule here is also enforced at runtime by `parseData`. They are pinned
 * because a rule carried by a type can stop applying instead of failing:
 * `ValidateTable` dispatched on the key `fields` for a day after the
 * declaration renamed it to `scalars`, and nothing said so. That whole type is
 * gone now — a table reaches `defineData` branded, so `defineTable` is the one
 * place a table is checked — and these pins are what would notice if the one
 * remaining door stopped checking.
 *
 * Nothing runs. `tsc` is the runner, and a `@ts-expect-error` that stops
 * erroring is itself an error.
 */

import { Ok } from 'wellcrafted/result';
import { plainText } from './content.js';

import { defineData, defineTable, field } from './index.js';

/**
 * A name is a scalar or a type field, never both.
 *
 * `RowOf` intersects the two buckets, so a collision reads as a `Static<>`
 * intersected with a `Y.Type`: an impossible field rather than a reported
 * mistake. `parseData` refuses it too; this pins the half that fires while the
 * declaration is being written.
 *
 * The expected type at the offending element IS the explanation, which is what
 * makes the error land on `'title'` instead of on the object around it.
 */
defineTable({
	scalars: { title: field.string() },
	// @ts-expect-error 'title' is already a scalar of this table
	types: ['title'],
	file: {
		serialize: () => ({ data: {}, content: '' }),
		deserialize: () => Ok({}) as never,
	},
	content: plainText(),
});

/**
 * A declared default is refused where it is authored, not at first open.
 *
 * `parseData` refuses one at runtime too (`DeclarationDefault`), and this is
 * the compile-time half of that rule, for both buckets a definition has.
 *
 * Pinned because the rule is carried by a conditional type keyed on the
 * literal string `scalars`. Rename the key and the check does not fail, it
 * stops applying, silently: that is exactly what happened to the table half
 * when the declaration went from one `fields` bag to two buckets.
 *
 * The default has to be spread in rather than passed to the builder. Every
 * builder returns a fixed schema type (`field.string(opts)` is `TString`
 * whatever `opts` says), so an annotation handed to one is erased before this
 * check can see it. Only a schema whose OWN type carries `default` is caught
 * here; the rest is `parseData`'s to refuse.
 */
/**
 * A table has one door, and a bare literal is not it.
 *
 * `defineTable` brands its return and `DataDefinition` requires the brand, so a
 * structurally-correct literal handed straight to `defineData` is refused. That
 * is what lets every table rule live on `defineTable`'s parameter alone: there
 * is no second authoring path left to re-check, which is what `ValidateTable`
 * and `ValidateDefinition` used to be for.
 *
 * It also fixed the message. On the old `defineData` path the refusal was
 * carried through `TData & ValidateDefinition<TData>`, and the intersection
 * collapsed the offending element to `never`, taking the explanation with it.
 * A collision now reports the same sentence wherever it is written.
 */
defineData({
	id: 'so.epicenter.bare-literal',
	kv: {},
	tables: {
		// @ts-expect-error a table is authored with `defineTable`
		notes: { scalars: { title: field.string() } },
	},
});

defineData({
	id: 'so.epicenter.declaration-default',
	kv: {
		// @ts-expect-error a default belongs to the application, not the schema
		theme: { ...field.string(), default: 'light' },
	},
	tables: {
		// @ts-expect-error a default belongs to the application, not the schema
		items: { scalars: { title: { ...field.string(), default: 'untitled' } } },
	},
});
