/**
 * Compile-time pins for the refusals in `define.ts`.
 *
 * Each rule here is also enforced at runtime by `parseData`, and each is
 * carried by a conditional type keyed on a literal string. That is why they
 * are pinned: rename a key and the rule does not fail, it stops applying, in
 * silence. `ValidateTable` dispatched on ``fields`` for a day after the
 * declaration grew two buckets, and nothing said so.
 *
 * Nothing runs. `tsc` is the runner, and a `@ts-expect-error` that stops
 * erroring is itself an error.
 */

import { Ok } from 'wellcrafted/result';

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
 * The same refusal on the other authoring path.
 *
 * A table written as a literal inside `defineData` skips `defineTable`, so it
 * is `ValidateTable` rather than `RejectScalarCollision` that has to catch the
 * collision. Only `definition.test.ts` and this file write tables that way;
 * every table in the repository goes through `defineTable`.
 *
 * The message does not survive this path. `defineData` takes
 * `TData & ValidateDefinition<TData>`, and the intersection collapses the
 * offending element to `never`, taking the sentence with it. The error still
 * lands on the name, and says only that a string is not assignable to `never`.
 */
defineData({
	id: 'so.epicenter.collision-inline',
	kv: {},
	tables: {
		// @ts-expect-error 'title' is already a scalar of this table
		notes: { scalars: { title: field.string() }, types: ['title'] },
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
