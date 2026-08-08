import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { defineTable, optional } from '@epicenter/lens/legacy';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { parseRow } from './parse.js';
import { planPush } from './plan.js';
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

function receipt(fields: Record<string, unknown>) {
	return fields as Record<string, never>;
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
	expect(
		claimFor({ title: 'T', status: 'draft', tags: [], content }).fields,
	).toHaveProperty('content', content);
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
	// The property the whole design rests on, and it needs nothing but the
	// receipt: a file matching what was written into it sends nothing, no matter
	// how far the row has moved since or how long it has been sitting.
	const fields = {
		title: 'Tuesday',
		status: 'draft',
		tags: ['work'],
		content: 'Ship Friday.\n',
	};
	const base = receipt(fields);

	expect(planPush({ claim: claimFor(fields), base })).toEqual({
		kind: 'patch',
		set: {},
		unset: [],
	});
});

test('a field you changed alone is patched', () => {
	const base = receipt({ title: 'Tuesday', status: 'draft', tags: ['work'] });
	const claim = claimFor({ ...base, tags: ['work', 'sync'] });

	const plan = planPush({ claim, base });
	expect(plan).toEqual({
		kind: 'patch',
		set: { tags: ['work', 'sync'] },
		unset: [],
	});
});

test('prose takes exactly the same path as any other field', () => {
	const base = receipt({
		title: 'T',
		status: 'draft',
		tags: [],
		content: 'Ship Friday.\n',
	});
	const claim = claimFor({ ...base, content: 'Ship Monday.\n' });

	const plan = planPush({ claim, base });
	expect(plan).toEqual({
		kind: 'patch',
		set: { content: 'Ship Monday.\n' },
		unset: [],
	});
});

test('a field you never touched is never sent, whatever any peer did to it', () => {
	// The only protection that matters, and it needs no knowledge of the row: a
	// field matching the receipt is absent from the patch, so nothing can clobber
	// what another device wrote to it.
	const base = receipt({ title: 'Tuesday', status: 'draft', tags: ['work'] });
	const claim = claimFor({ ...base, status: 'published' });

	const plan = planPush({ claim, base });
	expect(plan).toEqual({
		kind: 'patch',
		set: { status: 'published' },
		unset: [],
	});
});

test('clearing an optional field unsets it rather than writing null', () => {
	const base = receipt({
		title: 'T',
		status: 'draft',
		tags: [],
		reviewed: true,
	});
	const claim = claimFor({ title: 'T', status: 'draft', tags: [] });

	const plan = planPush({ claim, base });
	expect(plan).toEqual({ kind: 'patch', set: {}, unset: ['reviewed'] });
});

test('a claim with no id plans a creation', () => {
	const claim = expectOk(
		parseRow('---\ntitle: New\nstatus: draft\ntags: []\n---\nHello\n', notes),
	);
	const plan = planPush({ claim, base: undefined });

	expect(plan).toEqual({
		kind: 'create',
		set: { title: 'New', status: 'draft', tags: [], content: 'Hello\n' },
	});
});

test('a file with no recorded base is held rather than guessed at', () => {
	// Amnesia is the one thing that would let a stale file revert a peer, so a
	// file whose base was lost pushes nothing until it is re-rendered.
	const plan = planPush({
		claim: claimFor({ title: 'T', status: 'draft', tags: [] }),
		base: undefined,
	});
	expect(plan).toEqual({ kind: 'unbased' });
});
