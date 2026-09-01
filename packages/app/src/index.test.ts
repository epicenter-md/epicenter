import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import {
	AppError,
	createEpicenter,
	type EpicenterBinding,
} from './index.js';

function bindingFor(calls: string[]): EpicenterBinding {
	return {
		openData: async () => AppError.StorageFailed({ cause: 'unused' }),
		openSqlite: async (name) => {
			calls.push(name);
			return Ok({
				run: async () => Ok({ changes: 1 }),
				all: async () => Ok([]),
				batch: async (statements) => Ok({ changes: statements.map(() => 1) }),
			});
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
	const opened = await epicenter.openSqlite('mail');
	expect(opened.error).toBeNull();
	if (opened.error !== null) throw opened.error;
	expect(calls).toEqual(['mail']);
	expect('transaction' in opened.data).toBe(false);
	expect('close' in opened.data).toBe(false);
});

test('refuses invalid database names before reaching the owner', async () => {
	const calls: string[] = [];
	const epicenter = createEpicenter({
		appId: 'so.epicenter.test',
		binding: bindingFor(calls),
	});

	const result = await epicenter.openSqlite('../mail');
	expect(result.error?.name).toBe('InvalidDatabaseName');
	expect(calls).toEqual([]);
});

test('refuses an account id that is not one label', async () => {
	const epicenter = createEpicenter({
		appId: 'so.epicenter.test',
		binding: bindingFor([]),
	});

	const put = await epicenter.secrets.put('../other', 'token');
	expect(put.error?.name).toBe('InvalidAccountId');
	const read = await epicenter.secrets.get('a/b');
	expect(read.error?.name).toBe('InvalidAccountId');
});
