/**
 * Whispering Greenfield Workspace Slice Tests
 *
 * Exercises Whispering and Skills through one real Bun runtime. It proves that
 * stricter release-local lenses surface old JSON, app code repairs it through a
 * normal typed update, SQL remains read-only, and Skills text stays attached to
 * its owning row.
 *
 * Key behaviors:
 * - a historical recording remains stored but nonconforming under the new lens
 * - explicit app repair makes the row conform without a migration subsystem
 * - one runtime opens Whispering and Skills and keeps row documents isolated
 */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field, InstantString } from '@epicenter/field';
import { skillsWorkspace } from '@epicenter/skills';
import { defineTable, defineWorkspace } from '@epicenter/workspace/sqlite';
import { createBunWorkspaceRuntime } from '@epicenter/workspace/sqlite/bun';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { recordingsTable, whisperingWorkspace } from './definition';
import { repairRecordingSourceId } from './repair';

const { sourceId: _sourceId, ...historicalRecordingFields } =
	recordingsTable.fields;
const historicalWhisperingWorkspace = defineWorkspace({
	id: whisperingWorkspace.id,
	tables: {
		recordings: defineTable({ fields: historicalRecordingFields }),
	},
});

test('one runtime composes explicit recording repair, SQL, and Skills documents', async () => {
	const storageRoot = mkdtempSync(
		join(tmpdir(), 'epicenter-whispering-slice-'),
	);
	try {
		const historicalRuntime = createBunWorkspaceRuntime({
			storageScopeKey: 'local-person',
			storageRoot,
		});
		const historical = await historicalRuntime.open(
			historicalWhisperingWorkspace,
		);
		const oldRecording = await historical.tables.recordings.create({
			title: '',
			recordedAt: InstantString.now(),
			recordedAtZone: 'UTC',
			transcript: 'Stored before source ids',
			polishedTranscript: null,
			duration: null,
			transcription: null,
		});
		await historicalRuntime[Symbol.asyncDispose]();

		await using runtime = createBunWorkspaceRuntime({
			storageScopeKey: 'local-person',
			storageRoot,
		});
		const [whispering, skills] = await Promise.all([
			runtime.open(whisperingWorkspace),
			runtime.open(skillsWorkspace),
		]);
		const nonconforming = expectErr(
			await whispering.tables.recordings.get(oldRecording.id),
		);
		expect(nonconforming.issues).toContainEqual({
			field: 'sourceId',
			kind: 'missing',
			message: "Missing required field 'sourceId'",
		});

		const repaired = expectOk(
			await repairRecordingSourceId({
				workspace: whispering,
				canonicalId: oldRecording.id,
				sourceId: 'artifact-1',
			}),
		);
		expect(repaired?.sourceId).toBe('artifact-1');
		expect(
			await whispering.sql(
				'SELECT id, sourceId, transcript FROM recordings',
				[],
				Type.Object({
					id: field.string(),
					sourceId: field.string(),
					transcript: field.string(),
				}),
			),
		).toEqual([
			{
				id: oldRecording.id,
				sourceId: 'artifact-1',
				transcript: 'Stored before source ids',
			},
		]);

		const skill = await skills.tables.skills.create({
			sourceId: 'portable-summarizer',
			name: 'summarizer',
			description: 'Summarize the selected transcript',
			updatedAt: InstantString.now(),
		});
		await using instructions = await skills.tables.skills.document.open(
			skill.id,
		);
		const content = instructions.get('content');
		content.insert(0, 'Return three concise bullets.');
		expect(content.toString()).toBe('Return three concise bullets.');
		await expect(
			whispering.sql(
				"DELETE FROM recordings WHERE id = 'forbidden'",
				[],
				Type.Object({}),
			),
		).rejects.toThrow(/only SELECT/i);
	} finally {
		rmSync(storageRoot, { recursive: true, force: true });
	}
});
