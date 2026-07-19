/**
 * Whispering Greenfield Workspace Slice Tests
 *
 * Exercises Whispering and Skills through one real Bun runtime. It proves that
 * stricter release-local lenses discard old recording rows, SQL remains
 * read-only, and Skills text stays attached to
 * its owning row.
 *
 * Key behaviors:
 * - a historical recording remains stored but nonconforming under the new lens
 * - no repair or compatibility reader revives the old sourceId row
 * - one runtime opens Whispering and Skills and keeps row documents isolated
 */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBlobId } from '@epicenter/blobs';
import { field, InstantString } from '@epicenter/field';
import { skillsWorkspace } from '@epicenter/skills';
import { defineTable, defineWorkspace } from '@epicenter/workspace/sqlite';
import { createDeviceBunWorkspaceRuntime } from '@epicenter/workspace/sqlite/bun';
import { Type } from 'typebox';
import { expectErr } from 'wellcrafted/testing';
import { recordingsTable, whisperingWorkspace } from './definition';

const {
	audioBlobId: _audioBlobId,
	uploadedAt: _uploadedAt,
	...sharedRecordingFields
} = recordingsTable.fields;
const historicalRecordingFields = {
	...sharedRecordingFields,
	sourceId: field.string(),
};
const historicalWhisperingWorkspace = defineWorkspace({
	id: whisperingWorkspace.id,
	tables: {
		recordings: defineTable({ fields: historicalRecordingFields }),
	},
});

test('one runtime discards old sourceId rows and composes Skills documents', async () => {
	const storageRoot = mkdtempSync(
		join(tmpdir(), 'epicenter-whispering-slice-'),
	);
	try {
		const historicalRuntime = createDeviceBunWorkspaceRuntime({
			storageRoot,
		});
		const historical = await historicalRuntime.open(
			historicalWhisperingWorkspace,
		);
		const oldRecording = await historical.tables.recordings.create({
			sourceId: 'artifact-1',
			title: '',
			recordedAt: InstantString.now(),
			recordedAtZone: 'UTC',
			transcript: 'Stored before source ids',
			polishedTranscript: null,
			duration: null,
			transcription: null,
		});
		await historicalRuntime[Symbol.asyncDispose]();

		await using runtime = createDeviceBunWorkspaceRuntime({
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
			field: 'audioBlobId',
			kind: 'missing',
			message: "Missing required field 'audioBlobId'",
		});
		const listed = await whispering.tables.recordings.list();
		expect(listed.rows).toEqual([]);
		expect(listed.nonconforming).toHaveLength(1);
		const current = await whispering.tables.recordings.create({
			audioBlobId: generateBlobId(),
			uploadedAt: null,
			title: '',
			recordedAt: InstantString.now(),
			recordedAtZone: 'UTC',
			transcript: 'Current row',
			polishedTranscript: null,
			duration: null,
			transcription: null,
		});
		expect(
			await whispering.sql(
				'SELECT id, audioBlobId, transcript FROM recordings WHERE id = ?',
				[current.id],
				Type.Object({
					id: field.string(),
					audioBlobId: field.string(),
					transcript: field.string(),
				}),
			),
		).toEqual([
			{
				id: current.id,
				audioBlobId: current.audioBlobId,
				transcript: 'Current row',
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
