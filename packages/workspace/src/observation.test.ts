import { expect, test } from 'bun:test';
import { createLogger, memorySink } from 'wellcrafted/logger';
import type { RowAddress } from './addresses.js';
import {
	createInvalidationDispatcher,
	type TableInvalidation,
} from './observation.js';

const NAMESPACE = 'so.epicenter.test';

function rowId(index: number): string {
	return `row${String(index).padStart(21, '0')}`;
}

function row(tableName: string, index: number): RowAddress {
	return { namespace: NAMESPACE, tableName, rowId: rowId(index) };
}

test('one batched commit produces one invalidation per logical table', () => {
	const dispatcher = createInvalidationDispatcher();
	const notes: TableInvalidation[] = [];
	const tasks: TableInvalidation[] = [];
	dispatcher.subscribeTable(NAMESPACE, 'notes', (i) => notes.push(i));
	dispatcher.subscribeTable(NAMESPACE, 'tasks', (i) => tasks.push(i));

	const changes = [
		...Array.from({ length: 64 }, (_, index) => row('notes', index)),
		row('tasks', 100),
	];
	dispatcher.deliver(changes);

	// Sixty-four addresses, one call: the whole point of forwarding the commit
	// as one frame rather than sixty-four.
	expect(notes).toHaveLength(1);
	expect(notes[0]).toEqual({
		scope: 'rows',
		rowIds: Array.from({ length: 64 }, (_, index) => rowId(index)),
	});
	expect(tasks).toEqual([{ scope: 'rows', rowIds: [rowId(100)] }]);
});

test('a repeated address is named once', () => {
	const dispatcher = createInvalidationDispatcher();
	const seen: TableInvalidation[] = [];
	dispatcher.subscribeTable(NAMESPACE, 'notes', (i) => seen.push(i));

	dispatcher.deliver([row('notes', 1), row('notes', 1), row('notes', 2)]);

	expect(seen).toEqual([{ scope: 'rows', rowIds: [rowId(1), rowId(2)] }]);
});

test('the same table name in two namespaces is two handles', () => {
	const dispatcher = createInvalidationDispatcher();
	const mine: TableInvalidation[] = [];
	const theirs: TableInvalidation[] = [];
	dispatcher.subscribeTable(NAMESPACE, 'notes', (i) => mine.push(i));
	dispatcher.subscribeTable('so.epicenter.other', 'notes', (i) =>
		theirs.push(i),
	);

	dispatcher.deliver([row('notes', 3)]);

	expect(mine).toHaveLength(1);
	expect(theirs).toEqual([]);
});

test('registration never fires and unsubscribing is complete', () => {
	const dispatcher = createInvalidationDispatcher();
	const seen: TableInvalidation[] = [];
	const stop = dispatcher.subscribeTable(NAMESPACE, 'notes', (i) =>
		seen.push(i),
	);
	expect(seen).toEqual([]);

	stop();
	dispatcher.deliver([row('notes', 4)]);
	dispatcher.invalidateAll();

	expect(seen).toEqual([]);
});

test('a gap heals every subscribed handle at the strongest honest scope', () => {
	const dispatcher = createInvalidationDispatcher();
	const notes: TableInvalidation[] = [];
	const settings: TableInvalidation[] = [];
	dispatcher.subscribeTable(NAMESPACE, 'notes', (i) => notes.push(i));
	dispatcher.subscribeTable(NAMESPACE, 'settings', (i) => settings.push(i));

	dispatcher.invalidateAll();

	expect(notes).toEqual([{ scope: 'table' }]);
	expect(settings).toEqual([{ scope: 'table' }]);
});

test('a subscriber that throws does not cost another handle its invalidation', () => {
	const { sink, events } = memorySink();
	const dispatcher = createInvalidationDispatcher({
		log: createLogger('test/observation', sink),
	});
	const survivor: TableInvalidation[] = [];
	dispatcher.subscribeTable(NAMESPACE, 'notes', () => {
		throw new Error('subscriber exploded');
	});
	dispatcher.subscribeTable(NAMESPACE, 'tasks', (i) => survivor.push(i));

	dispatcher.deliver([row('notes', 5), row('tasks', 6)]);

	expect(survivor).toEqual([{ scope: 'rows', rowIds: [rowId(6)] }]);
	expect(JSON.stringify(events)).toContain('subscriber exploded');
});

test('an empty commit reaches nobody', () => {
	const dispatcher = createInvalidationDispatcher();
	let calls = 0;
	dispatcher.subscribeTable(NAMESPACE, 'notes', () => {
		calls += 1;
	});

	dispatcher.deliver([]);

	expect(calls).toBe(0);
});
