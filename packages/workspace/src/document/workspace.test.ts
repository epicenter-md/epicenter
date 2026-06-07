/**
 * createWorkspace tests: encrypted and plaintext construction, identity
 * agreement between `id` and `ydoc.guid`, and cascade disposal via
 * `using` syntax.
 */

import { describe, expect, test } from 'bun:test';
import type { Keyring } from '@epicenter/encryption';
import { bytesToBase64 } from '@epicenter/encryption';
import { randomBytes } from '@noble/ciphers/utils.js';
import { Type } from 'typebox';
import { field } from '@epicenter/field';
import { defineKv } from './define-kv.js';
import { defineTable } from './define-table.js';
import { createWorkspace } from './workspace.js';

function toKeyring(key: Uint8Array): Keyring {
	return [{ version: 1, keyBytesBase64: bytesToBase64(key) }];
}

const notesDefinition = defineTable({
	id: field.string(),
	title: field.string(),
});

const sortOrderDefinition = defineKv(
	Type.Enum(['asc', 'desc']),
	() => 'asc' as const,
);

describe('createWorkspace', () => {
	test('plaintext construction reads and writes', () => {
		const workspace = createWorkspace({
			id: 'ws-plain',
			tables: { notes: notesDefinition },
			kv: { sortOrder: sortOrderDefinition },
		});

		workspace.tables.notes.set({ id: '1', title: 'hello' });
		expect(workspace.tables.notes.get('1').data).toEqual({
			id: '1',
			title: 'hello',
		});

		expect(workspace.kv.get('sortOrder')).toBe('asc');
		workspace.kv.set('sortOrder', 'desc');
		expect(workspace.kv.get('sortOrder')).toBe('desc');

		workspace[Symbol.dispose]();
	});

	test('encrypted construction reads and writes', () => {
		const keyring = toKeyring(randomBytes(32));
		const workspace = createWorkspace({
			id: 'ws-encrypted',
			keyring: () => keyring,
			tables: { notes: notesDefinition },
			kv: { sortOrder: sortOrderDefinition },
		});

		workspace.tables.notes.set({ id: '1', title: 'secret' });
		expect(workspace.tables.notes.get('1').data).toEqual({
			id: '1',
			title: 'secret',
		});

		workspace.kv.set('sortOrder', 'desc');
		expect(workspace.kv.get('sortOrder')).toBe('desc');

		workspace[Symbol.dispose]();
	});

	test('workspace.ydoc.guid equals options.id', () => {
		const workspace = createWorkspace({
			id: 'ws-identity',
			tables: {},
			kv: {},
		});
		expect(workspace.ydoc.guid).toBe('ws-identity');
		workspace[Symbol.dispose]();
	});

	test('using-disposal destroys the underlying ydoc', () => {
		let destroyed = false;
		{
			using workspace = createWorkspace({
				id: 'ws-using',
				tables: { notes: notesDefinition },
				kv: {},
			});
			workspace.ydoc.once('destroy', () => {
				destroyed = true;
			});
		}
		expect(destroyed).toBe(true);
	});

	test('keyring callback throwing surfaces at construction', () => {
		expect(() =>
			createWorkspace({
				id: 'ws-no-keys',
				keyring: () => {
					throw new Error('not signed-in');
				},
				tables: { notes: notesDefinition },
				kv: {},
			}),
		).toThrow('not signed-in');
	});

	test('empty tables and empty kv are coherent', () => {
		const workspace = createWorkspace({
			id: 'ws-empty',
			tables: {},
			kv: {},
		});
		expect(workspace.ydoc.guid).toBe('ws-empty');
		expect(Object.keys(workspace.tables)).toEqual([]);
		workspace[Symbol.dispose]();
	});
});
