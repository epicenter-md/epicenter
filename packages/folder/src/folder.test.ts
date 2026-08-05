import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { defineTable, optional } from '@epicenter/lens';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { parseRow } from './parse.js';
import { isEmptyPlan, planPush, type RowState } from './plan.js';
import { renderRow } from './render.js';
import { applyTextEdits, textEdits } from './text-edits.js';

const notes = defineTable({
	fields: {
		title: field.string(),
		status: field.select(['draft', 'published']),
		tags: field.tags(),
		reviewed: optional(field.boolean()),
	},
	body: 'text',
});

const settings = defineTable({
	fields: { theme: field.select(['light', 'dark']) },
});

const ROW = 'a8fk2mq7x3nb5wd9pc1rt4vz';

function state(fields: Record<string, unknown>, body = ''): RowState {
	return { fields: fields as RowState['fields'], body };
}

// -- render and parse -------------------------------------------------------

test('a row renders and reads back to the same values', () => {
	const fields = {
		title: 'Tuesday',
		status: 'draft',
		tags: ['work', 'sync'],
		reviewed: false,
	};
	const text = renderRow({
		id: ROW,
		fields,
		body: 'Met with Sam.\nShip on Friday.\n',
		definition: notes,
	});

	const claim = expectOk(parseRow(text, notes));
	expect(claim.id).toBe(ROW);
	expect(claim.fields).toEqual(fields);
	expect(claim.body).toBe('Met with Sam.\nShip on Friday.\n');
});

test('values YAML would coerce survive because parsing is schema-directed', () => {
	// The Norway problem in one line: `no` and `1.10` are strings here because
	// the field says so, not because YAML guessed politely.
	const fields = { title: 'no', status: 'draft', tags: ['1.10', 'on', 'null'] };
	const claim = expectOk(
		parseRow(renderRow({ id: ROW, fields, definition: notes }), notes),
	);
	expect(claim.fields).toEqual(fields);
});

test('field order follows the declaration, not the row object', () => {
	const shuffled = renderRow({
		id: ROW,
		fields: { tags: [], status: 'draft', title: 'T' },
		definition: notes,
	});
	const declared = renderRow({
		id: ROW,
		fields: { title: 'T', status: 'draft', tags: [] },
		definition: notes,
	});
	// Identical bytes, so a render never rewrites a file just because the row's
	// JSON key order moved.
	expect(shuffled).toBe(declared);
	expect(shuffled.indexOf('id:')).toBeLessThan(shuffled.indexOf('title:'));
});

test('a table with no declared body renders and reads an empty body', () => {
	const text = renderRow({
		id: 'sound',
		fields: { theme: 'dark' },
		body: 'ignored',
		definition: settings,
	});
	expect(text.includes('ignored')).toBe(false);
	expect(expectOk(parseRow(text, settings)).body).toBe('');
});

test('a file with no id is a claim to create', () => {
	const claim = expectOk(
		parseRow('---\ntitle: New\nstatus: draft\ntags: []\n---\nBody\n', notes),
	);
	expect(claim.id).toBeUndefined();
});

test('claims are refused per file, naming the field', () => {
	expect(
		expectErr(parseRow('---\nid: bad id!\ntitle: T\n---\n', notes)).name,
	).toBe('InvalidId');
	expect(
		expectErr(parseRow('---\nresonance: 3\n---\n', notes)).name,
	).toBe('UnknownField');
	expect(
		expectErr(parseRow('---\nstatus: shipped\n---\n', notes)).name,
	).toBe('InvalidField');
	expect(expectErr(parseRow('---\n: :\n---\n', notes)).name).toBe('Unreadable');
});

// -- text edits -------------------------------------------------------------

test('an unchanged body produces no operations at all', () => {
	expect(textEdits('same\ntext\n', 'same\ntext\n')).toEqual([]);
});

test('a matching head and tail are left alone', () => {
	const base = 'Met with Sam. Ship on Friday.\n';
	const next = 'Met with Sam. Ship on Monday.\n';
	const edits = textEdits(base, next);

	expect(edits).toHaveLength(1);
	// The point of an operation over a replacement: only the changed region is
	// touched, so an open editor keeps everything around it.
	expect(edits[0]?.remove).toBeLessThan(base.length);
	expect(applyTextEdits(base, edits)).toBe(next);
});

test('an emoji is never split down the middle', () => {
	const base = 'ship 🚢 today\n';
	const next = 'ship 🚀 today\n';
	const edits = textEdits(base, next);
	const applied = applyTextEdits(base, edits);

	expect(applied).toBe(next);
	// A lone surrogate would survive a string comparison and corrupt the document.
	expect([...applied].every((point) => !/[\uD800-\uDFFF]/.test(point.length === 1 ? point : ''))).toBe(true);
});

test('insertions, deletions, and rewrites all round-trip', () => {
	const cases: Array<[string, string]> = [
		['', 'new\n'],
		['gone\n', ''],
		['a\n', 'a\nb\n'],
		['a\nb\n', 'a\n'],
		['Met with Sam.\n', 'Met with Sam and Alex.\n'],
		['one\ntwo\n', 'two\none\n'],
		['x\n'.repeat(50), `${'x\n'.repeat(25)}y\n${'x\n'.repeat(25)}`],
	];
	for (const [base, next] of cases) {
		expect(applyTextEdits(base, textEdits(base, next))).toBe(next);
	}
});

// -- the plan ---------------------------------------------------------------

test('a file you did not touch pushes nothing, however stale it is', () => {
	// The property the whole design rests on. `theirs` has moved far past `base`,
	// and the file is a month old, and still nothing is sent.
	const base = state({ title: 'Tuesday', status: 'draft', tags: ['work'] });
	const theirs = state({
		title: 'Tuesday, revised',
		status: 'published',
		tags: ['work', 'urgent'],
	});
	const claim = expectOk(
		parseRow(
			renderRow({ id: ROW, fields: base.fields, definition: notes }),
			notes,
		),
	);

	expect(isEmptyPlan(planPush({ claim, base, theirs, definition: notes }))).toBe(
		true,
	);
});

test('a field you changed alone is patched', () => {
	const base = state({ title: 'Tuesday', status: 'draft', tags: ['work'] });
	const claim = expectOk(
		parseRow(
			renderRow({
				id: ROW,
				fields: { ...base.fields, tags: ['work', 'sync'] },
				definition: notes,
			}),
			notes,
		),
	);

	const plan = planPush({ claim, base, theirs: base, definition: notes });
	expect(plan.set).toEqual({ tags: ['work', 'sync'] });
	expect(plan.conflicts).toEqual([]);
});

test('a peer changing a different field does not turn into a conflict', () => {
	const base = state({ title: 'Tuesday', status: 'draft', tags: ['work'] });
	const theirs = state({ ...base.fields, title: 'Tuesday, revised' });
	const claim = expectOk(
		parseRow(
			renderRow({
				id: ROW,
				fields: { ...base.fields, status: 'published' },
				definition: notes,
			}),
			notes,
		),
	);

	const plan = planPush({ claim, base, theirs, definition: notes });
	expect(plan.set).toEqual({ status: 'published' });
	expect(plan.conflicts).toEqual([]);
	// Their title is untouched precisely because it never entered the plan.
	expect('title' in plan.set).toBe(false);
});

test('the same field changed on both sides stops instead of guessing', () => {
	const base = state({ title: 'Tuesday', status: 'draft', tags: ['work'] });
	const theirs = state({ ...base.fields, tags: ['urgent'] });
	const claim = expectOk(
		parseRow(
			renderRow({
				id: ROW,
				fields: { ...base.fields, tags: ['sync'] },
				definition: notes,
			}),
			notes,
		),
	);

	const plan = planPush({ claim, base, theirs, definition: notes });
	expect(plan.set).toEqual({});
	expect(plan.conflicts).toEqual([
		{
			kind: 'field',
			field: 'tags',
			base: ['work'],
			mine: ['sync'],
			theirs: ['urgent'],
		},
	]);
});

test('clearing an optional field unsets it rather than writing null', () => {
	const base = state({
		title: 'T',
		status: 'draft',
		tags: [],
		reviewed: true,
	});
	const claim = expectOk(
		parseRow(
			renderRow({
				id: ROW,
				fields: { title: 'T', status: 'draft', tags: [] },
				definition: notes,
			}),
			notes,
		),
	);

	const plan = planPush({ claim, base, theirs: base, definition: notes });
	expect(plan.unset).toEqual(['reviewed']);
	expect(plan.set).toEqual({});
});

test('a body you changed alone becomes operations, not a replacement', () => {
	const base = state({ title: 'T', status: 'draft', tags: [] }, 'Ship Friday.\n');
	const claim = expectOk(
		parseRow(
			renderRow({
				id: ROW,
				fields: base.fields,
				body: 'Ship Monday.\n',
				definition: notes,
			}),
			notes,
		),
	);

	const plan = planPush({ claim, base, theirs: base, definition: notes });
	expect(plan.body.length).toBeGreaterThan(0);
	expect(applyTextEdits(base.body, plan.body)).toBe('Ship Monday.\n');
	expect(plan.conflicts).toEqual([]);
});

test('a body changed on both sides stops, exactly like a field', () => {
	const base = state({ title: 'T', status: 'draft', tags: [] }, 'Ship Friday.\n');
	const theirs = state(base.fields, 'Ship Friday, maybe.\n');
	const claim = expectOk(
		parseRow(
			renderRow({
				id: ROW,
				fields: base.fields,
				body: 'Ship Monday.\n',
				definition: notes,
			}),
			notes,
		),
	);

	const plan = planPush({ claim, base, theirs, definition: notes });
	expect(plan.body).toEqual([]);
	expect(plan.conflicts).toEqual([{ kind: 'body' }]);
});

test('a claim with no id plans a creation', () => {
	const claim = expectOk(
		parseRow('---\ntitle: New\nstatus: draft\ntags: []\n---\nHello\n', notes),
	);
	const plan = planPush({
		claim,
		base: undefined,
		theirs: undefined,
		definition: notes,
	});

	expect(plan.create).toBe(true);
	expect(plan.set).toEqual({ title: 'New', status: 'draft', tags: [] });
	expect(applyTextEdits('', plan.body)).toBe('Hello\n');
});

test('a file naming a vanished row reports rather than recreating it', () => {
	const claim = expectOk(
		parseRow(
			renderRow({
				id: ROW,
				fields: { title: 'T', status: 'draft', tags: [] },
				definition: notes,
			}),
			notes,
		),
	);
	const plan = planPush({
		claim,
		base: state({ title: 'T', status: 'draft', tags: [] }),
		theirs: undefined,
		definition: notes,
	});
	expect(plan.conflicts).toEqual([{ kind: 'row-vanished' }]);
	expect(plan.create).toBe(false);
});

test('a file with no recorded base is held rather than guessed at', () => {
	// Amnesia is the one thing that would let a stale file revert a peer, so a
	// file whose base was lost pushes nothing until it is re-rendered.
	const claim = expectOk(
		parseRow(
			renderRow({
				id: ROW,
				fields: { title: 'T', status: 'draft', tags: [] },
				definition: notes,
			}),
			notes,
		),
	);
	const plan = planPush({
		claim,
		base: undefined,
		theirs: state({ title: 'Other', status: 'draft', tags: [] }),
		definition: notes,
	});
	expect(plan.conflicts).toEqual([{ kind: 'unbased' }]);
	expect(plan.set).toEqual({});
});
