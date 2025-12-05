import { expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	boolean,
	date,
	id,
	integer,
	json,
	real,
	select,
	tags,
	text,
	ytext,
} from '../columns';
import { tableSchemaToYjsArktypeType } from './arktype-yjs';

test('validates Y.Text for ytext columns', () => {
	const schema = {
		id: id(),
		content: ytext(),
	};

	const validator = tableSchemaToYjsArktypeType(schema);
	const ytext = new Y.Text();
	ytext.insert(0, 'Hello World');

	const result = validator({
		id: '123',
		content: ytext,
	});

	expect(result instanceof type.errors).toBe(false);
});

test('validates Y.Text | null for nullable ytext columns', () => {
	const schema = {
		id: id(),
		content: ytext({ nullable: true }),
	};

	const validator = tableSchemaToYjsArktypeType(schema);

	// Test with Y.Text
	const ytext = new Y.Text();
	const result1 = validator({
		id: '123',
		content: ytext,
	});
	expect(result1 instanceof type.errors).toBe(false);

	// Test with null
	const result2 = validator({
		id: '123',
		content: null,
	});
	expect(result2 instanceof type.errors).toBe(false);
});

test('rejects string for ytext columns', () => {
	const schema = {
		id: id(),
		content: ytext(),
	};

	const validator = tableSchemaToYjsArktypeType(schema);

	const result = validator({
		id: '123',
		content: 'plain string',
	});

	expect(result instanceof type.errors).toBe(true);
	if (result instanceof type.errors) {
		expect(result.summary).toContain('content');
	}
});

test('validates Y.Array for multi-select columns', () => {
	const schema = {
		id: id(),
		tags: tags(['tech', 'blog', 'news']),
	};

	const validator = tableSchemaToYjsArktypeType(schema);
	const yarray = new Y.Array();
	yarray.push(['tech', 'blog']);

	const result = validator({
		id: '123',
		tags: yarray,
	});

	expect(result instanceof type.errors).toBe(false);
});

test('validates Y.Array | null for nullable multi-select columns', () => {
	const schema = {
		id: id(),
		tags: tags(['tech', 'blog'], { nullable: true }),
	};

	const validator = tableSchemaToYjsArktypeType(schema);

	// Test with Y.Array
	const yarray = new Y.Array();
	const result1 = validator({
		id: '123',
		tags: yarray,
	});
	expect(result1 instanceof type.errors).toBe(false);

	// Test with null
	const result2 = validator({
		id: '123',
		tags: null,
	});
	expect(result2 instanceof type.errors).toBe(false);
});

test('rejects plain array for multi-select columns', () => {
	const schema = {
		id: id(),
		tags: tags(['tech', 'blog']),
	};

	const validator = tableSchemaToYjsArktypeType(schema);

	const result = validator({
		id: '123',
		tags: ['tech', 'blog'], // Plain array instead of Y.Array
	});

	expect(result instanceof type.errors).toBe(true);
	if (result instanceof type.errors) {
		expect(result.summary).toContain('tags');
	}
});

test('validates string for text columns', () => {
	const schema = {
		id: id(),
		title: text(),
	};

	const validator = tableSchemaToYjsArktypeType(schema);

	const result = validator({
		id: '123',
		title: 'Hello World',
	});

	expect(result instanceof type.errors).toBe(false);
});

test('validates number for integer columns', () => {
	const schema = {
		id: id(),
		count: integer(),
	};

	const validator = tableSchemaToYjsArktypeType(schema);

	const result = validator({
		id: '123',
		count: 42,
	});

	expect(result instanceof type.errors).toBe(false);
});

test('rejects non-integer for integer columns', () => {
	const schema = {
		id: id(),
		count: integer(),
	};

	const validator = tableSchemaToYjsArktypeType(schema);

	const result = validator({
		id: '123',
		count: 42.5,
	});

	expect(result instanceof type.errors).toBe(true);
});

test('validates number for real columns', () => {
	const schema = {
		id: id(),
		price: real(),
	};

	const validator = tableSchemaToYjsArktypeType(schema);

	const result1 = validator({
		id: '123',
		price: 42.5,
	});
	expect(result1 instanceof type.errors).toBe(false);

	const result2 = validator({
		id: '123',
		price: 42,
	});
	expect(result2 instanceof type.errors).toBe(false);
});

test('validates boolean for boolean columns', () => {
	const schema = {
		id: id(),
		published: boolean(),
	};

	const validator = tableSchemaToYjsArktypeType(schema);

	const result = validator({
		id: '123',
		published: true,
	});

	expect(result instanceof type.errors).toBe(false);
});

test('validates date strings for date columns', () => {
	const schema = {
		id: id(),
		createdAt: date(),
	};

	const validator = tableSchemaToYjsArktypeType(schema);

	const result = validator({
		id: '123',
		createdAt: '2024-01-01T20:00:00.000Z|America/New_York',
	});

	expect(result instanceof type.errors).toBe(false);
});

test('validates select options for select columns', () => {
	const schema = {
		id: id(),
		status: select(['draft', 'published', 'archived']),
	};

	const validator = tableSchemaToYjsArktypeType(schema);

	const result = validator({
		id: '123',
		status: 'published',
	});

	expect(result instanceof type.errors).toBe(false);
});

test('rejects invalid options for select columns', () => {
	const schema = {
		id: id(),
		status: select(['draft', 'published']),
	};

	const validator = tableSchemaToYjsArktypeType(schema);

	const result = validator({
		id: '123',
		status: 'invalid',
	});

	expect(result instanceof type.errors).toBe(true);
});

test('validates JSON columns with schema', () => {
	const metadataSchema = type({
		version: 'number',
		author: 'string',
	});

	const schema = {
		id: id(),
		metadata: json({ schema: metadataSchema }),
	};

	const validator = tableSchemaToYjsArktypeType(schema);

	const result = validator({
		id: '123',
		metadata: { version: 1, author: 'John' },
	});

	expect(result instanceof type.errors).toBe(false);
});

test('rejects invalid JSON columns', () => {
	const metadataSchema = type({
		version: 'number',
		author: 'string',
	});

	const schema = {
		id: id(),
		metadata: json({ schema: metadataSchema }),
	};

	const validator = tableSchemaToYjsArktypeType(schema);

	const result = validator({
		id: '123',
		metadata: { version: 'not a number', author: 'John' },
	});

	expect(result instanceof type.errors).toBe(true);
});

test('validates complex Row with YJS types', () => {
	const schema = {
		id: id(),
		title: text(),
		content: ytext(),
		tags: tags(['tech', 'blog']),
		published: boolean(),
		viewCount: integer(),
		rating: real({ nullable: true }),
	};

	const validator = tableSchemaToYjsArktypeType(schema);

	const ytext = new Y.Text();
	ytext.insert(0, 'Content here');
	const yarray = new Y.Array();
	yarray.push(['tech']);

	const result = validator({
		id: '123',
		title: 'Test Post',
		content: ytext,
		tags: yarray,
		published: true,
		viewCount: 42,
		rating: null,
	});

	expect(result instanceof type.errors).toBe(false);
});

test('validates Row with getters (buildRowFromYRow pattern)', () => {
	const schema = {
		id: id(),
		title: text(),
		content: ytext(),
	};

	const validator = tableSchemaToYjsArktypeType(schema);

	// Simulate buildRowFromYRow pattern with getters
	const ytext = new Y.Text();
	ytext.insert(0, 'Content');

	const mockYRow = new Map([
		['id', '123'],
		['title', 'Test'],
		['content', ytext],
	]);

	const row: Record<string, unknown> = {};
	Object.defineProperties(row, {
		id: {
			get: () => mockYRow.get('id'),
			enumerable: true,
			configurable: true,
		},
		title: {
			get: () => mockYRow.get('title'),
			enumerable: true,
			configurable: true,
		},
		content: {
			get: () => mockYRow.get('content'),
			enumerable: true,
			configurable: true,
		},
	});

	const result = validator(row);

	expect(result instanceof type.errors).toBe(false);
});
