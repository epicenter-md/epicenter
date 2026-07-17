/**
 * Workspace Runtime Tests
 *
 * Verifies that imported definitions bind without opening storage, record
 * owners initialize once on first use, and synchronization intent shares the
 * canonical SQLite transaction.
 *
 * Key behaviors:
 * - repeated opens return one borrowed handle and one lazy record owner
 * - create, patch, and delete admit only schema-opaque record commands
 * - admission failure rolls back the optimistic canonical write
 * - runtime disposal closes owners and revokes borrowed handles
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import type { RecordCommand } from '@epicenter/row-sync';
import { createBunSqliteAdapter } from '@epicenter/row-sync/bun';
import { expectOk } from 'wellcrafted/testing';
import { document } from './document-definition.js';
import { createDocumentRoomCatalog } from './document-runtime.js';
import { defineTable } from './lens-definition.js';
import { createWorkspaceRuntime } from './runtime.js';
import { defineWorkspace } from './runtime-definition.js';

const skillsDefinition = defineWorkspace({
	id: 'skills',
	tables: {
		skills: defineTable({
			fields: {
				title: field.string(),
				category: field.string(),
			},
			optional: ['category'],
		}),
	},
	documents: {
		preferences: document.keyValue({ entries: { theme: field.string() } }),
	},
});

function setup({
	failInitialization = false,
	mutateAdmitted = false,
	rejectTitle,
}: {
	mutateAdmitted?: boolean;
	rejectTitle?: string;
	failInitialization?: boolean;
} = {}) {
	let opens = 0;
	let closes = 0;
	const commands: RecordCommand[] = [];
	const databases: Database[] = [];
	const rejectedKinds = new Set<RecordCommand['kind']>();
	const documentUpdates = new Map<string, Uint8Array>();
	const documentLoads: string[] = [];
	const documentRoomCatalog = createDocumentRoomCatalog({
		localStore: {
			async rememberRoom() {},
			async load(roomId) {
				documentLoads.push(roomId);
				return documentUpdates.get(roomId);
			},
			async save(roomId, update) {
				documentUpdates.set(roomId, update);
			},
		},
	});
	const runtime = createWorkspaceRuntime({
		authorityKey: 'principal-alice',
		documentRoomCatalog,
		async openRecordOwner(workspaceId) {
			void workspaceId;
			opens += 1;
			const database = new Database(':memory:');
			databases.push(database);
			const adapter = createBunSqliteAdapter(database);
			return {
				sqlite: failInitialization
					? {
							...adapter,
							run(sql, parameters) {
								if (sql.includes('CREATE TEMP VIEW')) {
									throw new Error('lens initialization failed');
								}
								adapter.run(sql, parameters);
							},
						}
					: adapter,
				admit(command) {
					if (rejectedKinds.has(command.kind)) {
						throw new Error('outbox unavailable');
					}
					if (
						rejectTitle &&
						command.kind !== 'deleteRow' &&
						command.kind === 'createRow' &&
						command.value.title === rejectTitle
					) {
						throw new Error('outbox unavailable');
					}
					commands.push(structuredClone(command));
					if (mutateAdmitted && command.kind === 'createRow') {
						command.value.title = 'Mutated by admission';
					}
				},
				async [Symbol.asyncDispose]() {
					closes += 1;
					database.close();
				},
			};
		},
	});
	return {
		runtime,
		commands,
		databases,
		documentLoads,
		rejectedKinds,
		get opens() {
			return opens;
		},
		get closes() {
			return closes;
		},
	};
}

test('open binds one borrowed handle without opening records', async () => {
	const state = setup();
	await using runtime = state.runtime;
	const [first, second] = await Promise.all([
		runtime.open(skillsDefinition),
		runtime.open(skillsDefinition),
	]);

	expect(first).toBe(second);
	expect(state.opens).toBe(0);
	expect(state.documentLoads).toEqual([]);
	await using preferences = await first.documents.preferences.open();
	preferences.content.set('theme', 'dark');
	expect(state.documentLoads).toHaveLength(1);
	expect(state.opens).toBe(0);
	await first.tables.skills.get('missing');
	await second.tables.skills.scan({ limit: 10 });
	expect(state.opens).toBe(1);
});

test('typed writes admit exactly create, patch, and delete commands', async () => {
	const state = setup();
	await using runtime = state.runtime;
	const skills = await runtime.open(skillsDefinition);
	const created = await skills.tables.skills.create({ title: 'Concise' });
	await skills.tables.skills.patch(created.id, { category: 'writing' });
	await skills.tables.skills.patch('remote-only', { title: 'Late intent' });
	await skills.tables.skills.patch(created.id, {});
	await skills.tables.skills.delete(created.id);

	expect(state.commands).toEqual([
		{
			kind: 'createRow',
			table: 'skills',
			rowId: created.id,
			value: { title: 'Concise' },
		},
		{
			kind: 'patchRow',
			table: 'skills',
			rowId: created.id,
			set: { category: 'writing' },
			unset: [],
		},
		{
			kind: 'patchRow',
			table: 'skills',
			rowId: 'remote-only',
			set: { title: 'Late intent' },
			unset: [],
		},
		{ kind: 'deleteRow', table: 'skills', rowId: created.id },
	]);
});

test('admission failure rolls back the canonical create', async () => {
	const state = setup({ rejectTitle: 'Reject me' });
	await using runtime = state.runtime;
	const skills = await runtime.open(skillsDefinition);

	await expect(
		skills.tables.skills.create({ title: 'Reject me' }),
	).rejects.toThrow('outbox unavailable');
	expect((await skills.tables.skills.scan({ limit: 10 })).rows).toEqual([]);
	expect(state.commands).toEqual([]);
});

test('admission cannot mutate the canonical value returned to callers', async () => {
	const state = setup({ mutateAdmitted: true });
	await using runtime = state.runtime;
	const skills = await runtime.open(skillsDefinition);
	const created = await skills.tables.skills.create({ title: 'Canonical' });

	expect(created.title).toBe('Canonical');
	expect(expectOk(await skills.tables.skills.get(created.id))).toEqual(created);
});

test('admission failure rolls back canonical patch and delete', async () => {
	const state = setup();
	await using runtime = state.runtime;
	const skills = await runtime.open(skillsDefinition);
	const created = await skills.tables.skills.create({ title: 'Keep me' });

	state.rejectedKinds.add('patchRow');
	await expect(
		skills.tables.skills.patch(created.id, { category: 'writing' }),
	).rejects.toThrow('outbox unavailable');
	expect(expectOk(await skills.tables.skills.get(created.id))).toEqual(created);

	state.rejectedKinds.add('deleteRow');
	await expect(skills.tables.skills.delete(created.id)).rejects.toThrow(
		'outbox unavailable',
	);
	expect(expectOk(await skills.tables.skills.get(created.id))).toEqual(created);
});

test('one runtime refuses two definition objects for one workspace id', async () => {
	const state = setup();
	await using runtime = state.runtime;
	await runtime.open(skillsDefinition);
	const anotherRelease = defineWorkspace({
		id: 'skills',
		tables: skillsDefinition.tables,
	});

	await expect(runtime.open(anotherRelease)).rejects.toThrow(
		'already bound to another definition',
	);
	expect(state.opens).toBe(0);
});

test('runtime disposal closes one owner and revokes borrowed handles', async () => {
	const state = setup();
	const skills = await state.runtime.open(skillsDefinition);
	const created = await skills.tables.skills.create({ title: 'Persisted' });
	expect(expectOk(await skills.tables.skills.get(created.id))).toEqual(created);

	await state.runtime[Symbol.asyncDispose]();
	expect(state.closes).toBe(1);
	await expect(skills.tables.skills.get(created.id)).rejects.toThrow(
		'Workspace runtime is disposed',
	);
	await state.runtime[Symbol.asyncDispose]();
	expect(state.closes).toBe(1);
});

test('failed record initialization disposes the opened owner exactly once', async () => {
	const state = setup({ failInitialization: true });
	const skills = await state.runtime.open(skillsDefinition);

	await expect(skills.tables.skills.get('missing')).rejects.toThrow(
		'lens initialization failed',
	);
	expect(state.opens).toBe(1);
	expect(state.closes).toBe(1);
	await state.runtime[Symbol.asyncDispose]();
	expect(state.closes).toBe(1);
});

test('runtime disposal aborts a stalled lazy record owner open', async () => {
	const documentRoomCatalog = createDocumentRoomCatalog({
		localStore: {
			async rememberRoom() {},
			async load() {
				return undefined;
			},
			async save() {},
		},
	});
	let receivedSignal: AbortSignal | undefined;
	const runtime = createWorkspaceRuntime({
		authorityKey: 'principal-alice',
		documentRoomCatalog,
		openRecordOwner(_workspaceId, signal) {
			receivedSignal = signal;
			return new Promise((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(signal.reason), {
					once: true,
				});
			});
		},
	});
	const skills = await runtime.open(skillsDefinition);
	const pendingRead = skills.tables.skills
		.get('missing')
		.catch((cause) => cause);
	await Bun.sleep(0);
	expect(receivedSignal?.aborted).toBe(false);

	await runtime[Symbol.asyncDispose]();
	expect(receivedSignal?.aborted).toBe(true);
	expect(await pendingRead).toBeDefined();
});
