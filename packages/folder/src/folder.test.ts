import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { defineTable, optional } from '@epicenter/lens';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { parseRow } from './parse.js';
import { isEmptyPlan, planPush, type RowState } from './plan.js';
import { renderRow } from './render.js';

const notes = defineTable({
	fields: {
		title: field.string(),
		status: field.select(['draft', 'published']),
		tags: field.tags(),
		reviewed: optional(field.boolean()),
		content: optional(field.string()),
	},
	body: 'content',
});

const settings = defineTable({
	fields: { theme: field.select(['light', 'dark']) },
});

const ROW = 'a8fk2mq7x3nb5wd9pc1rt4vz';

function state(fields: Record<string, unknown>): RowState {
	return { fields: fields as RowState['fields'] };
}

function claimFor(fields: Record<string, unknown>, definition = notes) {
	return expectOk(
		parseRow(
			renderRow({ id: ROW, fields: fields as never, definition }),
			definition,
		),
	);
}

// -- render and parse -------------------------------------------------------

test('a row renders and reads back to the same values', () => {
	const fields = {
		title: 'Tuesday',
		status: 'draft',
		tags: ['work', 'sync'],
		reviewed: false,
		content: 'Met with Sam.\nShip on Friday.\n',
	};
	const text = renderRow({ id: ROW, fields, definition: notes });

	const claim = expectOk(parseRow(text, notes));
	expect(claim.id).toBe(ROW);
	expect(claim.fields).toEqual(fields);
});

test('the body field is written below the fence, not inside it', () => {
	const text = renderRow({
		id: ROW,
		fields: { title: 'T', status: 'draft', tags: [], content: 'Prose here.\n' },
		definition: notes,
	});

	expect(text.includes('content:')).toBe(false);
	expect(text.endsWith('Prose here.\n')).toBe(true);
});

test('prose that looks like frontmatter still round-trips', () => {
	const content = '---\nnot: frontmatter\n---\n\nreal body\n';
	expect(claimFor({ title: 'T', status: 'draft', tags: [], content }).fields)
		.toHaveProperty('content', content);
});

test('values YAML would coerce survive because parsing is schema-directed', () => {
	// The Norway problem in one line: `no` and `1.10` stay strings because the
	// field says so, not because YAML guessed politely.
	const fields = { title: 'no', status: 'draft', tags: ['1.10', 'on', 'null'] };
	expect(claimFor(fields).fields).toEqual(fields);
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

test('a table with no declared body renders every field in frontmatter', () => {
	const text = renderRow({
		id: 'sound',
		fields: { theme: 'dark' },
		definition: settings,
	});
	expect(text.includes('theme: dark')).toBe(true);
	expect(text.endsWith('---\n')).toBe(true);
	expect(expectOk(parseRow(text, settings)).fields).toEqual({ theme: 'dark' });
});

test('an empty body clears an optional body field rather than setting it empty', () => {
	const claim = claimFor({ title: 'T', status: 'draft', tags: [] });
	expect('content' in claim.fields).toBe(false);
});

test('a file with no id is a claim to create', () => {
	const claim = expectOk(
		parseRow('---\ntitle: New\nstatus: draft\ntags: []\n---\nBody\n', notes),
	);
	expect(claim.id).toBeUndefined();
	expect(claim.fields.content).toBe('Body\n');
});

test('claims are refused per file, naming the field', () => {
	expect(
		expectErr(parseRow('---\nid: bad id!\ntitle: T\n---\n', notes)).name,
	).toBe('InvalidId');
	expect(expectErr(parseRow('---\nresonance: 3\n---\n', notes)).name).toBe(
		'UnknownField',
	);
	expect(expectErr(parseRow('---\nstatus: shipped\n---\n', notes)).name).toBe(
		'InvalidField',
	);
	expect(expectErr(parseRow('---\n: :\n---\n', notes)).name).toBe('Unreadable');
});

test('putting the body in frontmatter is refused rather than given two homes', () => {
	expect(
		expectErr(parseRow('---\ncontent: inline\n---\nbelow\n', notes)).name,
	).toBe('BodyInFrontmatter');
});

// -- the plan ---------------------------------------------------------------

test('a file you did not touch pushes nothing, however stale it is', () => {
	// The property the whole design rests on. `theirs` has moved far past `base`,
	// and the file is a month old, and still nothing is sent.
	const fields = {
		title: 'Tuesday',
		status: 'draft',
		tags: ['work'],
		content: 'Ship Friday.\n',
	};
	const base = state(fields);
	const theirs = state({
		title: 'Tuesday, revised',
		status: 'published',
		tags: ['work', 'urgent'],
		content: 'Ship Friday, maybe.\n',
	});

	expect(isEmptyPlan(planPush({ claim: claimFor(fields), base, theirs }))).toBe(
		true,
	);
});

test('a field you changed alone is patched', () => {
	const base = state({ title: 'Tuesday', status: 'draft', tags: ['work'] });
	const claim = claimFor({ ...base.fields, tags: ['work', 'sync'] });

	const plan = planPush({ claim, base, theirs: base });
	expect(plan.set).toEqual({ tags: ['work', 'sync'] });
	expect(plan.conflicts).toEqual([]);
});

test('prose takes exactly the same path as any other field', () => {
	const base = state({
		title: 'T',
		status: 'draft',
		tags: [],
		content: 'Ship Friday.\n',
	});
	const claim = claimFor({ ...base.fields, content: 'Ship Monday.\n' });

	const plan = planPush({ claim, base, theirs: base });
	expect(plan.set).toEqual({ content: 'Ship Monday.\n' });
	expect(plan.conflicts).toEqual([]);
});

test('a peer changing a different field does not turn into a conflict', () => {
	const base = state({ title: 'Tuesday', status: 'draft', tags: ['work'] });
	const theirs = state({ ...base.fields, title: 'Tuesday, revised' });
	const claim = claimFor({ ...base.fields, status: 'published' });

	const plan = planPush({ claim, base, theirs });
	expect(plan.set).toEqual({ status: 'published' });
	expect(plan.conflicts).toEqual([]);
	// Their title is untouched precisely because it never entered the plan.
	expect('title' in plan.set).toBe(false);
});

test('the same field changed on both sides stops instead of guessing', () => {
	const base = state({ title: 'Tuesday', status: 'draft', tags: ['work'] });
	const theirs = state({ ...base.fields, tags: ['urgent'] });
	const claim = claimFor({ ...base.fields, tags: ['sync'] });

	const plan = planPush({ claim, base, theirs });
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

test('prose changed on both sides stops, exactly like any other field', () => {
	const base = state({
		title: 'T',
		status: 'draft',
		tags: [],
		content: 'Ship Friday.\n',
	});
	const theirs = state({ ...base.fields, content: 'Ship Friday, maybe.\n' });
	const claim = claimFor({ ...base.fields, content: 'Ship Monday.\n' });

	const plan = planPush({ claim, base, theirs });
	expect(plan.set).toEqual({});
	expect(plan.conflicts[0]).toMatchObject({ kind: 'field', field: 'content' });
});

test('clearing an optional field unsets it rather than writing null', () => {
	const base = state({ title: 'T', status: 'draft', tags: [], reviewed: true });
	const claim = claimFor({ title: 'T', status: 'draft', tags: [] });

	const plan = planPush({ claim, base, theirs: base });
	expect(plan.unset).toEqual(['reviewed']);
	expect(plan.set).toEqual({});
});

test('a claim with no id plans a creation', () => {
	const claim = expectOk(
		parseRow('---\ntitle: New\nstatus: draft\ntags: []\n---\nHello\n', notes),
	);
	const plan = planPush({ claim, base: undefined, theirs: undefined });

	expect(plan.create).toBe(true);
	expect(plan.set).toEqual({
		title: 'New',
		status: 'draft',
		tags: [],
		content: 'Hello\n',
	});
});

test('a file naming a vanished row reports rather than recreating it', () => {
	const plan = planPush({
		claim: claimFor({ title: 'T', status: 'draft', tags: [] }),
		base: state({ title: 'T', status: 'draft', tags: [] }),
		theirs: undefined,
	});
	expect(plan.conflicts).toEqual([{ kind: 'row-vanished' }]);
	expect(plan.create).toBe(false);
});

test('a file with no recorded base is held rather than guessed at', () => {
	// Amnesia is the one thing that would let a stale file revert a peer, so a
	// file whose base was lost pushes nothing until it is re-rendered.
	const plan = planPush({
		claim: claimFor({ title: 'T', status: 'draft', tags: [] }),
		base: undefined,
		theirs: state({ title: 'Other', status: 'draft', tags: [] }),
	});
	expect(plan.conflicts).toEqual([{ kind: 'unbased' }]);
	expect(plan.set).toEqual({});
});
