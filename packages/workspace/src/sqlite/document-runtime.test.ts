/**
 * Parameterized Document Runtime Tests
 *
 * Verifies that release-local declarations open stable private Yjs rooms while
 * authority identity, persistence, synchronization, and room lifetime remain
 * runtime-owned.
 *
 * Key behaviors:
 * - canonical domain params select stable, distinct private rooms
 * - open awaits local hydration and final release unloads without deleting data
 * - released capabilities are revoked and invalid params fail before opening
 * - key-value validation changes do not change durable room identity
 */
import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import { document } from './document-definition.js';
import {
	createDocumentNamespace,
	createDocumentRoomCatalog,
	type DocumentLocalStore,
	type DocumentRoomManifest,
} from './document-runtime.js';

type SkillId = string & Brand<'SkillId'>;

const asSkillId = (value: string): SkillId => value as SkillId;

const documents = {
	instructions: document.text({ params: { skillId: field.string<SkillId>() } }),
	localized: document.text({
		params: {
			skillId: field.string<SkillId>(),
			locale: field.string(),
		},
	}),
	editor: document.xmlFragment({
		params: { skillId: field.string<SkillId>() },
	}),
	'prototype-key': document.text({
		params: { ['__proto__']: field.string() },
	}),
	preferences: document.keyValue({
		entries: {
			theme: field.select(['light', 'dark']),
			density: field.json(Type.Union([Type.Literal('compact'), Type.Null()])),
		},
	}),
};

function setup() {
	const updates = new Map<string, Uint8Array>();
	const manifests = new Map<string, DocumentRoomManifest>();
	const loads: string[] = [];
	const saves: string[] = [];
	const syncOpens: string[] = [];
	const syncCloses: string[] = [];
	const localStore: DocumentLocalStore = {
		async rememberRoom(manifest) {
			const previous = manifests.get(manifest.storageRef);
			if (previous && JSON.stringify(previous) !== JSON.stringify(manifest)) {
				throw new Error('Manifest collision');
			}
			manifests.set(manifest.storageRef, structuredClone(manifest));
		},
		async load(roomId) {
			loads.push(roomId);
			const update = updates.get(roomId);
			return update?.slice();
		},
		async save(roomId, update) {
			saves.push(roomId);
			updates.set(roomId, update.slice());
		},
	};
	const roomCatalog = createDocumentRoomCatalog({
		localStore,
		attachSync(_ydoc, roomId) {
			syncOpens.push(roomId);
			return {
				[Symbol.dispose]() {
					syncCloses.push(roomId);
				},
			};
		},
	});
	let runtimeOpen = true;
	const namespace = createDocumentNamespace({
		authorityKey: 'principal-alice',
		workspaceId: 'skills',
		definitions: documents,
		roomCatalog,
		assertRuntimeOpen() {
			if (!runtimeOpen) throw new Error('Runtime is disposed');
		},
	});
	return {
		loads,
		saves,
		syncOpens,
		syncCloses,
		updates,
		manifests,
		localStore,
		roomCatalog,
		namespace,
		disposeRuntime() {
			runtimeOpen = false;
		},
	};
}

test('same params share one private room and distinct params open distinct rooms', async () => {
	const { namespace, roomCatalog, loads, syncOpens } = setup();
	try {
		const first = await namespace.instructions.open({
			skillId: asSkillId('skill-a'),
		});
		const second = await namespace.instructions.open({
			skillId: asSkillId('skill-a'),
		});
		const other = await namespace.instructions.open({
			skillId: asSkillId('skill-b'),
		});

		first.content.write('shared');
		expect(second.content.read()).toBe('shared');
		expect(other.content.read()).toBe('');
		expect(new Set(loads).size).toBe(2);
		expect(new Set(syncOpens).size).toBe(2);

		first[Symbol.dispose]();
		second[Symbol.dispose]();
		other[Symbol.dispose]();
	} finally {
		await roomCatalog[Symbol.asyncDispose]();
	}
});

test('prototype-special parameter keys remain part of private room identity', async () => {
	const { namespace, roomCatalog, manifests } = setup();
	try {
		const firstParams = Object.fromEntries([['__proto__', 'first']]) as {
			__proto__: string;
		};
		const secondParams = Object.fromEntries([['__proto__', 'second']]) as {
			__proto__: string;
		};
		using first = await namespace['prototype-key'].open(firstParams);
		using second = await namespace['prototype-key'].open(secondParams);
		expect(first.content.read()).toBe('');
		expect(second.content.read()).toBe('');
		expect(manifests.size).toBe(2);
		const stored = [...manifests.values()];
		expect(stored[0]?.storageRef).not.toBe(stored[1]?.storageRef);
		expect(Object.hasOwn(stored[0]?.params ?? {}, '__proto__')).toBe(true);
		expect(Object.hasOwn(stored[1]?.params ?? {}, '__proto__')).toBe(true);
	} finally {
		await roomCatalog[Symbol.asyncDispose]();
	}
});

test('text observers receive local and synchronized transactions', async () => {
	const { namespace, roomCatalog } = setup();
	try {
		const first = await namespace.instructions.open({
			skillId: asSkillId('skill-a'),
		});
		const second = await namespace.instructions.open({
			skillId: asSkillId('skill-a'),
		});
		const observed: string[] = [];
		const unobserve = second.content.observe(() => {
			observed.push(second.content.read());
		});

		first.content.write('shared');
		first.content.insert(6, ' text');
		expect(observed).toEqual(['shared', 'shared text']);
		unobserve();
		first.content.write('not observed');
		expect(observed).toEqual(['shared', 'shared text']);

		first[Symbol.dispose]();
		second[Symbol.dispose]();
	} finally {
		await roomCatalog[Symbol.asyncDispose]();
	}
});

test('disposing one lease removes its observers while a shared room stays live', async () => {
	const { namespace, roomCatalog } = setup();
	try {
		const observedText: string[] = [];
		const firstText = await namespace.instructions.open({
			skillId: asSkillId('skill-a'),
		});
		const secondText = await namespace.instructions.open({
			skillId: asSkillId('skill-a'),
		});
		firstText.content.observe(() =>
			observedText.push(firstText.content.read()),
		);
		firstText[Symbol.dispose]();
		secondText.content.write('still live');
		expect(observedText).toEqual([]);

		const observedPreferences: Array<'light' | 'dark' | undefined> = [];
		const firstPreferences = await namespace.preferences.open();
		const secondPreferences = await namespace.preferences.open();
		firstPreferences.content.observe(() =>
			observedPreferences.push(firstPreferences.content.get('theme')),
		);
		firstPreferences[Symbol.dispose]();
		secondPreferences.content.set('theme', 'dark');
		expect(observedPreferences).toEqual([]);

		secondText[Symbol.dispose]();
		secondPreferences[Symbol.dispose]();
	} finally {
		await roomCatalog[Symbol.asyncDispose]();
	}
});

test('canonical param ordering selects one stable room', async () => {
	const { namespace, roomCatalog, loads } = setup();
	try {
		const first = await namespace.localized.open({
			skillId: asSkillId('skill-a'),
			locale: 'en',
		});
		const second = await namespace.localized.open({
			locale: 'en',
			skillId: asSkillId('skill-a'),
		});
		first.content.write('hello');
		expect(second.content.read()).toBe('hello');
		expect(new Set(loads).size).toBe(1);
		first[Symbol.dispose]();
		second[Symbol.dispose]();
	} finally {
		await roomCatalog[Symbol.asyncDispose]();
	}
});

test('final release unloads a room and reopening hydrates persisted content', async () => {
	const { namespace, roomCatalog, loads, saves, syncCloses, updates } = setup();
	try {
		const first = await namespace.instructions.open({
			skillId: asSkillId('skill-a'),
		});
		first.content.write('persist me');
		first[Symbol.dispose]();
		await Bun.sleep(0);

		expect(syncCloses).toHaveLength(1);

		const reopened = await namespace.instructions.open({
			skillId: asSkillId('skill-a'),
		});
		expect(reopened.content.read()).toBe('persist me');
		expect(loads).toHaveLength(2);
		expect(saves.length).toBeGreaterThan(0);
		expect(updates).toHaveLength(1);
		reopened[Symbol.dispose]();
	} finally {
		await roomCatalog[Symbol.asyncDispose]();
	}
});

test('durable room manifest reconstructs a document after catalog restart', async () => {
	const { namespace, roomCatalog, localStore, manifests } = setup();
	const first = await namespace.instructions.open({
		skillId: asSkillId('skill-a'),
	});
	first.content.write('survives restart');
	first[Symbol.dispose]();
	await roomCatalog[Symbol.asyncDispose]();

	const [manifest] = manifests.values();
	expect(manifest).toMatchObject({
		formatVersion: 1,
		workspaceId: 'skills',
		declaration: 'instructions',
		documentFormat: 'text/1',
		params: { skillId: 'skill-a' },
	});
	expect(manifest?.storageRef).toMatch(/^document-[a-f0-9]{64}$/);

	const restartedCatalog = createDocumentRoomCatalog({ localStore });
	const restarted = createDocumentNamespace({
		authorityKey: 'principal-alice',
		workspaceId: 'skills',
		definitions: documents,
		roomCatalog: restartedCatalog,
		assertRuntimeOpen() {},
	});
	try {
		const reopened = await restarted.instructions.open({
			skillId: asSkillId('skill-a'),
		});
		expect(reopened.content.read()).toBe('survives restart');
		reopened[Symbol.dispose]();
	} finally {
		await restartedCatalog[Symbol.asyncDispose]();
	}
});

test('xml fragment content persists and every retained capability is revoked', async () => {
	const { namespace, roomCatalog } = setup();
	try {
		const editor = await namespace.editor.open({
			skillId: asSkillId('skill-a'),
		});
		editor.content.write('rich text');
		const content = editor.content;
		const binding = editor.content.binding;
		editor[Symbol.dispose]();
		expect(() => content.read()).toThrow(/lease is disposed/i);
		expect(() => binding.toString()).toThrow(/lease is disposed/i);

		const reopened = await namespace.editor.open({
			skillId: asSkillId('skill-a'),
		});
		expect(reopened.content.read()).toBe('rich text');
		reopened[Symbol.dispose]();
	} finally {
		await roomCatalog[Symbol.asyncDispose]();
	}
});

test('released and runtime-disposed content capabilities throw', async () => {
	const { namespace, roomCatalog, disposeRuntime } = setup();
	try {
		const released = await namespace.instructions.open({
			skillId: asSkillId('skill-a'),
		});
		const releasedContent = released.content;
		released[Symbol.dispose]();
		expect(() => releasedContent.read()).toThrow(/lease is disposed/i);

		const runtimeOwned = await namespace.preferences.open();
		disposeRuntime();
		expect(() => runtimeOwned.content.get('theme')).toThrow(
			/runtime is disposed/i,
		);
		runtimeOwned[Symbol.dispose]();
	} finally {
		await roomCatalog[Symbol.asyncDispose]();
	}
});

test('invalid params fail before persistence or synchronization opens', async () => {
	const { namespace, roomCatalog, loads, syncOpens } = setup();
	try {
		await expect(
			namespace.instructions.open({ skillId: 42 } as never),
		).rejects.toThrow(/invalid document param/i);
		await expect(
			namespace.instructions.open({ skillId: 'skill-a', extra: true } as never),
		).rejects.toThrow(/exactly the declared keys/i);
		expect(() => document.text({ params: { value: Type.Any() } })).toThrow(
			/field\.\* vocabulary/i,
		);
		expect(() =>
			document.keyValue({ entries: { raw: Type.Object({}) } }),
		).toThrow(/field\.\* vocabulary/i);
		expect(loads).toHaveLength(0);
		expect(syncOpens).toHaveLength(0);
	} finally {
		await roomCatalog[Symbol.asyncDispose]();
	}
});

test('open resolves after local hydration and only then attaches synchronization', async () => {
	let finishLoad: (() => void) | undefined;
	const loadGate = new Promise<void>((resolve) => {
		finishLoad = resolve;
	});
	const events: string[] = [];
	const roomCatalog = createDocumentRoomCatalog({
		localStore: {
			async rememberRoom() {},
			async load() {
				events.push('load-start');
				await loadGate;
				events.push('load-end');
				return undefined;
			},
			async save() {},
		},
		attachSync() {
			events.push('sync-attach');
			return { [Symbol.dispose]() {} };
		},
	});
	const namespace = createDocumentNamespace({
		authorityKey: 'principal-alice',
		workspaceId: 'skills',
		definitions: documents,
		roomCatalog,
		assertRuntimeOpen() {},
	});
	try {
		let resolved = false;
		const opening = namespace.preferences.open().then((lease) => {
			resolved = true;
			return lease;
		});
		await Bun.sleep(0);
		expect(events).toEqual(['load-start']);
		expect(resolved).toBe(false);

		finishLoad?.();
		const lease = await opening;
		expect(events).toEqual(['load-start', 'load-end', 'sync-attach']);
		lease[Symbol.dispose]();
	} finally {
		await roomCatalog[Symbol.asyncDispose]();
	}
});

test('key-value schemas validate values without participating in room identity', async () => {
	const { roomCatalog, loads } = setup();
	try {
		const versionOne = createDocumentNamespace({
			authorityKey: 'principal-alice',
			workspaceId: 'skills',
			definitions: {
				preferences: document.keyValue({
					entries: { theme: field.string() },
				}),
			},
			roomCatalog,
			assertRuntimeOpen() {},
		});
		const first = await versionOne.preferences.open();
		first.content.set('theme', 'dark');
		first[Symbol.dispose]();

		const versionTwo = createDocumentNamespace({
			authorityKey: 'principal-alice',
			workspaceId: 'skills',
			definitions: {
				preferences: document.keyValue({
					entries: {
						theme: field.select(['dark']),
						density: field.string(),
					},
				}),
			},
			roomCatalog,
			assertRuntimeOpen() {},
		});
		const second = await versionTwo.preferences.open();
		expect(second.content.get('theme')).toBe('dark');
		expect(second.content.get('density')).toBeUndefined();
		expect(new Set(loads).size).toBe(1);
		second[Symbol.dispose]();
	} finally {
		await roomCatalog[Symbol.asyncDispose]();
	}
});

test('key-value delete represents absence while null remains a stored value', async () => {
	const { namespace, roomCatalog } = setup();
	try {
		const preferences = await namespace.preferences.open();
		let changes = 0;
		const stop = preferences.content.observe(() => {
			changes += 1;
		});
		preferences.content.set('density', null);
		expect(preferences.content.get('density')).toBeNull();
		preferences.content.delete('density');
		expect(preferences.content.get('density')).toBeUndefined();
		expect(changes).toBe(2);
		expect(() =>
			preferences.content.set('density', undefined as never),
		).toThrow(/invalid key-value value/i);
		stop();
		preferences[Symbol.dispose]();
	} finally {
		await roomCatalog[Symbol.asyncDispose]();
	}
});

test('failed persistence retains the zero-reference room for recovery', async () => {
	let saveAttempts = 0;
	const roomCatalog = createDocumentRoomCatalog({
		localStore: {
			async rememberRoom() {},
			async load() {
				return undefined;
			},
			async save() {
				saveAttempts += 1;
				throw new Error('disk unavailable');
			},
		},
	});
	const namespace = createDocumentNamespace({
		authorityKey: 'principal-alice',
		workspaceId: 'skills',
		definitions: documents,
		roomCatalog,
		assertRuntimeOpen() {},
	});
	const first = await namespace.instructions.open({
		skillId: asSkillId('skill-a'),
	});
	first.content.write('not yet durable');
	first[Symbol.dispose]();
	await Bun.sleep(0);

	const recovered = await namespace.instructions.open({
		skillId: asSkillId('skill-a'),
	});
	expect(recovered.content.read()).toBe('not yet durable');
	expect(saveAttempts).toBe(1);
	recovered[Symbol.dispose]();
	await expect(roomCatalog[Symbol.asyncDispose]()).rejects.toThrow(
		'Document room catalog disposal failed',
	);
});

test('catalog disposal destroys every room when sync teardown throws', async () => {
	const opened: import('yjs').Doc[] = [];
	let disposals = 0;
	const roomCatalog = createDocumentRoomCatalog({
		localStore: {
			async rememberRoom() {},
			async load() {
				return undefined;
			},
			async save() {},
		},
		attachSync(ydoc) {
			opened.push(ydoc);
			return {
				[Symbol.dispose]() {
					disposals += 1;
					throw new Error('sync teardown failed');
				},
			};
		},
	});
	const namespace = createDocumentNamespace({
		authorityKey: 'principal-alice',
		workspaceId: 'skills',
		definitions: documents,
		roomCatalog,
		assertRuntimeOpen() {},
	});
	await namespace.instructions.open({ skillId: asSkillId('one') });
	await namespace.instructions.open({ skillId: asSkillId('two') });

	await expect(roomCatalog[Symbol.asyncDispose]()).rejects.toThrow(
		'Document room catalog disposal failed',
	);
	expect(disposals).toBe(2);
	expect(opened.every((ydoc) => ydoc.isDestroyed)).toBe(true);
});
