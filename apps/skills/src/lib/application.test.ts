/**
 * Skills runtime tests.
 *
 * Skills is device-only, and this is what that means in practice: one
 * document, opened for the page lifetime, holding work that stays on this
 * machine and comes back when it reopens (ADR-0233). There is no auth client
 * in this build and no account replica, so there is exactly one ready shape.
 *
 * Key behaviors:
 * - The runtime opens the device document and nothing else
 * - A skill and its markdown survive reopening
 * - An aborted boot rejects with the abort
 *
 * `fake-indexeddb` supplies the browser store's storage, the harness the other
 * runtime tests in this repo use.
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';

// The state module IS reactive state, so the runes are shimmed to their
// non-reactive meaning. These assertions read imperatively: the question is
// what the document holds, not whether a view recomputed.
(globalThis as unknown as { $state: unknown }).$state = Object.assign(
	<TValue>(value: TValue) => value,
	{ raw: <TValue>(value: TValue) => value },
);
(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(
	<TValue>(value: TValue) => value,
	{ by: <TValue>(derive: () => TValue) => derive() },
);

import { SKILL_CONTENT, skillsDefinition } from '@epicenter/skills';
import { openSkillsRuntime } from './application.js';

async function resetStorage(): Promise<void> {
	for (const database of await indexedDB.databases()) {
		const name = database.name;
		if (name === undefined) continue;
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.deleteDatabase(name);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}
}

test('the runtime opens the device document and nothing else', async () => {
	await resetStorage();
	await using runtime = await openSkillsRuntime();

	expect(runtime.state.skills).toEqual([]);

	const names = (await indexedDB.databases()).map(({ name }) => name);
	expect(names).toEqual([`epicenter/${skillsDefinition.id}/device`]);
});

test('a skill and its instructions survive reopening', async () => {
	await resetStorage();
	let skillId: string;
	{
		await using runtime = await openSkillsRuntime();
		skillId = runtime.state.createSkill('writing-voice');
		const opened = await runtime.data.tables.skills.document.open(skillId);
		if (opened.error !== null) throw opened.error;
		using handle = opened.data;
		if (handle === undefined) throw new Error('the row has no document');
		const content = handle.get(SKILL_CONTENT);
		content.applyDelta(content.change.insert('Write directly.') as never);
		// The durable flush is asynchronous, so a reopen must wait for it.
		await runtime.data.store.persistence.flush();
		expect(runtime.data.store.persistence.get()).toBe('saved');
	}

	await using reopened = await openSkillsRuntime();
	expect(reopened.state.skills.map(({ name }) => name)).toEqual([
		'writing-voice',
	]);
	const opened = await reopened.data.tables.skills.document.open(skillId);
	if (opened.error !== null) throw opened.error;
	using handle = opened.data;
	expect(handle?.get(SKILL_CONTENT).toString()).toBe('Write directly.');
});

test('an aborted boot rejects with the abort', async () => {
	await resetStorage();
	const controller = new AbortController();
	controller.abort(new Error('root unmounted'));

	expect(openSkillsRuntime({ signal: controller.signal })).rejects.toThrow(
		'root unmounted',
	);
});
