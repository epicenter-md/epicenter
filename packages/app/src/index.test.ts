import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import {
	createEpicenter,
	databaseName,
	type EpicenterBinding,
	secretLabel,
} from './index.js';

function bindingFor(calls: string[]): EpicenterBinding {
	return {
		open: async (name) => {
			calls.push(name);
			return Ok({
				run: async () => Ok({ changes: 1 }),
				all: async () => Ok([]),
				batch: async (statements) => Ok({ changes: statements.map(() => 1) }),
			});
		},
		delete: async (name) => {
			calls.push(`delete:${name}`);
			return Ok(undefined);
		},
		secrets: {
			put: async () => Ok(undefined),
			get: async () => Ok(null),
			delete: async () => Ok(undefined),
		},
	};
}

test('creates a handle scoped to one application', async () => {
	const calls: string[] = [];
	const epicenter = createEpicenter({
		appId: 'so.epicenter.test',
		binding: bindingFor(calls),
	});

	expect(epicenter.appId).toBe('so.epicenter.test');
	const opened = await epicenter.sqlite.open(databaseName('mail'));
	expect(opened.error).toBeNull();
	if (opened.error !== null) throw opened.error;
	expect(calls).toEqual(['mail']);
	expect('transaction' in opened.data).toBe(false);
	expect('close' in opened.data).toBe(false);
});

test('deleting takes the same name as opening', async () => {
	const calls: string[] = [];
	const epicenter = createEpicenter({
		appId: 'so.epicenter.test',
		binding: bindingFor(calls),
	});

	const deleted = await epicenter.sqlite.delete(databaseName('mail'));
	expect(deleted.error).toBeNull();
	expect(calls).toEqual(['delete:mail']);
});

test('a handle with no definition has no store and no account', () => {
	const epicenter = createEpicenter({
		appId: 'so.epicenter.test',
		binding: bindingFor([]),
	});

	// The type says this already: `[TDefinition] extends [never]` fails
	// downward, so omitting the definition yields the smaller handle. The
	// runtime agrees, which is what keeps a `in` test from finding one.
	expect('data' in epicenter).toBe(false);
	expect('account' in epicenter).toBe(false);
	expect('eraseReplica' in epicenter).toBe(false);
});

test('a name is checked where it is minted, not on every call', () => {
	// The six per-call guards are gone (ADR-0339). What refuses a name that
	// could be read as a path is the mint, and it throws, because a name
	// reaching it is a constant in a build.
	expect(() => databaseName('../mail')).toThrow('is not valid');
	expect(() => databaseName('Mail')).toThrow('is not valid');
	expect(String(databaseName('mail'))).toBe('mail');

	expect(() => secretLabel('../other')).toThrow('is not valid');
	expect(() => secretLabel('a/b')).toThrow('is not valid');
	expect(String(secretLabel('sub-one'))).toBe('sub-one');
});

test('an application id this platform cannot file refuses at construction', () => {
	expect(() =>
		createEpicenter({ appId: 'not an app id', binding: bindingFor([]) }),
	).toThrow('is not valid');
});
