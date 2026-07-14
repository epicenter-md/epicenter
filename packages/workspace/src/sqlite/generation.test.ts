/**
 * Application Generation Lock Tests
 *
 * Verifies that source declarations produce one canonical durable-plane map
 * and that only an exact published entry authorizes a workspace at runtime.
 *
 * Key behaviors:
 * - App and generation derive the only workspace identity
 * - KV defaults are excluded while durable schemas and formats are locked
 * - Lock parsing rejects drift, malformed history, and noncanonical planes
 */

import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { openStandaloneWorkspace as openBrowserWorkspace } from './browser.js';
import {
	defineKv,
	defineTable,
	defineWorkspace,
	inspectWorkspaceCandidate,
	lockWorkspace,
	type WorkspaceCandidate,
	type WorkspaceDefinition,
} from './definition.js';
import { document } from './document-format.js';
import {
	applicationWorkspaceId,
	parseApplicationGenerationLock,
} from './generation.js';

function lockFor(
	candidate: ReturnType<typeof defineWorkspace>,
	entries: unknown[] = [candidate.proposedLockEntry],
) {
	return {
		format: 'epicenter.application-generation-lock/1',
		appId: candidate.appId,
		generations: entries,
	};
}

function candidateFor(dataGeneration = 1) {
	return defineWorkspace({
		appId: 'generation-test',
		dataGeneration,
		tables: {
			notes: defineTable({
				fields: { id: field.string(), title: field.string() },
				documents: { body: document.plainText },
			}),
		},
		kv: { theme: defineKv(field.string(), () => 'light') },
		blobs: { attachments: 'epicenter.test-attachment/1' },
	});
}

describe('application generation source', () => {
	test('derives one generation-qualified identity and canonical plane map', () => {
		const candidate = candidateFor(2);

		expect(candidate.workspaceId).toBe('generation-test-g2');
		expect(candidate.kvDocumentGuid).toBe('generation-test-g2.kv');
		expect(candidate.blobs.attachments).toEqual({
			identity: 'generation-test-g2.blob.attachments',
			contract: 'epicenter.test-attachment/1',
		});
		expect(Object.keys(candidate.proposedLockEntry.planes)).toEqual([
			'blob.attachments',
			'document.notes.body',
			'kv',
			'kv.theme',
		]);
		expect(candidate.proposedLockEntry.planes.kv).toBe('generation-test-g2.kv');
		expect(candidate.proposedLockEntry.planes['kv.theme']).toMatch(
			/^sha256:[0-9a-f]{64}$/,
		);
		expect(candidate.proposedLockEntry.planes['document.notes.body']).toMatch(
			/^epicenter\.sqlite-child-document-guid\/1;row-id=epicenter\.document-row\/1;guid=generation-test-g2\.notes\.<row-id-sha256>\.body\.[0-9a-f]{64}$/,
		);
		expect(candidate.proposedLockEntry.planes['blob.attachments']).toMatch(
			/^generation-test-g2\.blob\.attachments@sha256:[0-9a-f]{64}$/,
		);
		expect(Object.isFrozen(candidate.proposedLockEntry)).toBe(true);
		expect(Object.isFrozen(candidate.proposedLockEntry.planes)).toBe(true);
	});

	test('KV executable defaults do not participate in durable identity', () => {
		function planes(defaultValue: string) {
			return defineWorkspace({
				appId: 'defaults-test',
				dataGeneration: 1,
				tables: {
					rows: defineTable({ fields: { id: field.string() } }),
				},
				kv: { theme: defineKv(field.string(), () => defaultValue) },
			}).proposedLockEntry.planes;
		}

		expect(planes('light')).toEqual(planes('dark'));
	});

	test('rejects unsafe app ids and non-positive generations', () => {
		expect(() => applicationWorkspaceId('Unsafe', 1)).toThrow(
			'Invalid application id',
		);
		expect(() => applicationWorkspaceId('safe', 0)).toThrow('positive integer');
		expect(() => applicationWorkspaceId('safe', 1.5)).toThrow(
			'positive integer',
		);
	});
});

describe('lockWorkspace', () => {
	test('browser opening rejects an unlocked cast before creating a Worker', async () => {
		const candidate = candidateFor();
		let workerCreated = false;

		await expect(
			openBrowserWorkspace(
				candidate as unknown as WorkspaceDefinition<typeof candidate.tables>,
				{
					worker() {
						workerCreated = true;
						return null as never;
					},
					onObserverError() {},
				},
			),
		).rejects.toThrow('must be returned by lockWorkspace()');
		expect(workerCreated).toBe(false);
	});

	test('rejects casted and copied candidate lookalikes', () => {
		const candidate = candidateFor();
		const copied = {
			...candidate,
		} as unknown as WorkspaceCandidate;

		expect(() => inspectWorkspaceCandidate(copied)).toThrow(
			'must be returned by defineWorkspace()',
		);
		expect(() => lockWorkspace(copied, lockFor(candidate))).toThrow(
			'must be returned by defineWorkspace()',
		);
		expect(inspectWorkspaceCandidate(candidate)).toEqual({
			appId: candidate.appId,
			proposedLockEntry: candidate.proposedLockEntry,
		});
	});

	test('authorizes a published historical generation in a later lock', () => {
		const generationOne = candidateFor(1);
		const generationTwo = candidateFor(2);
		const lock = lockFor(generationOne, [
			generationOne.proposedLockEntry,
			generationTwo.proposedLockEntry,
		]);

		const workspace = lockWorkspace(generationOne, lock);
		expect(workspace.workspaceId).toBe('generation-test-g1');
		expect(Object.isFrozen(workspace)).toBe(true);
	});

	test('rejects a missing or drifted source entry', () => {
		const generationOne = candidateFor(1);
		const generationTwo = candidateFor(2);
		expect(() =>
			lockWorkspace(
				generationOne,
				lockFor(generationOne, [generationTwo.proposedLockEntry]),
			),
		).toThrow('does not publish generation 1');

		const drifted = {
			...generationOne.proposedLockEntry,
			planes: {
				...generationOne.proposedLockEntry.planes,
				'kv.theme': `sha256:${'0'.repeat(64)}`,
			},
		};
		expect(() =>
			lockWorkspace(generationOne, lockFor(generationOne, [drifted])),
		).toThrow('does not publish generation 1');
	});
});

describe('parseApplicationGenerationLock', () => {
	test('returns an immutable exact lock', () => {
		const candidate = candidateFor();
		const parsed = parseApplicationGenerationLock(lockFor(candidate));

		expect(parsed.appId).toBe(candidate.appId);
		expect(parsed.generations).toEqual([candidate.proposedLockEntry]);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.generations)).toBe(true);
		expect(Object.isFrozen(parsed.generations[0]?.planes)).toBe(true);
	});

	test('rejects extra keys, invalid generated ids, and unordered history', () => {
		const one = candidateFor(1);
		const two = candidateFor(2);
		expect(() =>
			parseApplicationGenerationLock({ ...lockFor(one), extra: true }),
		).toThrow('Invalid application generation lock');
		expect(() =>
			parseApplicationGenerationLock(
				lockFor(one, [{ ...one.proposedLockEntry, workspaceId: 'forged' }]),
			),
		).toThrow('invalid workspace id');
		expect(() =>
			parseApplicationGenerationLock(
				lockFor(one, [two.proposedLockEntry, one.proposedLockEntry]),
			),
		).toThrow('strictly increasing');
	});

	test('rejects noncanonical or unknown durable planes', () => {
		const candidate = candidateFor();
		const entries = (planes: Record<string, string>) => [
			{ ...candidate.proposedLockEntry, planes },
		];
		expect(() =>
			parseApplicationGenerationLock(
				lockFor(
					candidate,
					entries({ kv: candidate.kvDocumentGuid, 'blob.bad': 'bad' }),
				),
			),
		).toThrow('canonically sorted');
		expect(() =>
			parseApplicationGenerationLock(
				lockFor(
					candidate,
					entries({ kv: candidate.kvDocumentGuid, unknown: 'value' }),
				),
			),
		).toThrow("Unknown application generation plane 'unknown'");
	});
});
