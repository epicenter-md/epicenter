/**
 * Compile-time pins for the refusals in `define.ts`.
 *
 * Each rule here is also enforced at runtime by `parseData`. They are pinned
 * because a rule carried by a type can stop applying instead of failing:
 * `ValidateTable` dispatched on the key `fields` for a day after the
 * table fields are now top-level keys, so nothing needs a second wrapper or a
 * public list of content names. That whole type is gone now — a table reaches
 * `defineData` branded, so `defineTable` is the one
 * place a table is checked — and these pins are what would notice if the one
 * remaining door stopped checking.
 *
 * Nothing runs. `tsc` is the runner, and a `@ts-expect-error` that stops
 * erroring is itself an error.
 */

import { plainText } from './content.js';

import { defineData, defineTable, field } from './index.js';

/**
 * A value cannot take a name a row already has.
 *
 * Every row holds an `id` and a `content` node (ADR-0299), so a value at
 * either name would collide with the row's own field: `RowOf` intersects the
 * two, and the field would read as an impossible type rather than as a
 * mistake. `parseData` refuses it too; this pins the half that fires while the
 * declaration is being written.
 *
 * The expected type at the offending KEY is the explanation, which is what
 * makes the error land on the field instead of on the object around it.
 *
 * This replaced a pin for a rule that no longer exists: a name declared as
 * both a value and the content key. When `types` was deleted, that pin kept
 * passing, because its `@ts-expect-error` absorbed the excess-property error
 * for `types` itself. Probed to confirm: with `types` removed entirely and an
 * unrelated key in its place, the expectation was still satisfied. A pin that
 * cannot tell you what it is pinning is the failure this file exists to catch.
 */
defineTable({
	// @ts-expect-error content is reserved for the table's codec
	content: field.string(),
});

defineTable({
	// @ts-expect-error every table declares its content codec
	title: field.string(),
});

defineTable({
	// @ts-expect-error 'id' is reserved: every row already has one
	id: field.string(),
	content: plainText(),
});

/**
 * A declared default is refused where it is authored, not at first open.
 *
 * `parseData` refuses one at runtime too (`DeclarationDefault`), and this is
 * the compile-time half of that rule, for both buckets a definition has.
 *
 * Through `defineTable` rather than a table literal handed to `defineData`. A
 * literal is refused for having no brand, and that refusal fires FIRST: the
 * table half of this pin used to sit on a bare literal, and it passed with the
 * default removed entirely, so it was testing the door rather than the
 * default. The kv half below is genuine, because `kv` takes a bare field map.
 *
 * The default has to be spread in rather than passed to the builder. Every
 * builder returns a fixed schema type (`field.string(opts)` is `TString`
 * whatever `opts` says), so an annotation handed to one is erased before this
 * check can see it. Only a schema whose OWN type carries `default` is caught
 * here; the rest is `parseData`'s to refuse.
 */
defineTable({
	// @ts-expect-error a default belongs to the application, not the schema
	title: { ...field.string(), default: 'untitled' },
	content: plainText(),
});

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
		notes: { title: field.string() },
	},
});

defineData({
	id: 'so.epicenter.declaration-default',
	kv: {
		// @ts-expect-error a default belongs to the application, not the schema
		theme: { ...field.string(), default: 'light' },
	},
	tables: {
		items: defineTable({
			title: field.string(),
			content: plainText(),
		}),
	},
});
