/** Whispering's real @epicenter/data slice over Bun SQLite replicas. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBlobId } from '@epicenter/blobs';
import { defineLens, defineTable } from '@epicenter/data/legacy';
import { openBunEpicenter } from '@epicenter/data/legacy/bun';
import { InstantString } from '@epicenter/field';
import { expectOk } from 'wellcrafted/testing';
import { createBunEpicenterSyncRuntime } from '../../../../../packages/server/src/epicenter-sync/bun';
import {
	createWhisperingSettingDefaults,
	recordingsTable,
	whisperingSettingRow,
	whisperingSettingFields,
	WHISPERING_SETTINGS_ROW_ID,
} from './definition';

function recording(title: string, recordedAt: InstantString) {
	return {
		audioBlobId: generateBlobId(),
		uploadedAt: null,
		title,
		recordedAt,
		recordedAtZone: 'UTC',
		transcript: '',
		polishedTranscript: null,
		duration: null,
		transcription: null,
	};
}

test('settings are one row at a chosen id, patched and subscribed per field', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-data-settings-'));
	try {
		await using epicenter = await openBunEpicenter({ directory: root });
		const settings = epicenter.bind(
			defineLens({
				namespace: 'so.epicenter.whispering',
				tables: { settings: defineTable({ fields: whisperingSettingFields }) },
			}),
		).settings;
		let changes = 0;
		const stop = settings.subscribe(() => {
			changes += 1;
		});
		expect(
			expectOk(await settings.get(WHISPERING_SETTINGS_ROW_ID)),
		).toBeUndefined();
		await settings.create(WHISPERING_SETTINGS_ROW_ID, {
			...whisperingSettingRow(createWhisperingSettingDefaults('Groq')),
			settings_transcription_language: 'en',
		} as never);
		expect(
			expectOk(await settings.get(WHISPERING_SETTINGS_ROW_ID))
				?.settings_transcription_language,
		).toBe('en');
		// Each setting is its own key, so one patch moves one setting and leaves
		// the rest of the row alone.
		await settings.patch(WHISPERING_SETTINGS_ROW_ID, {
			settings_transcription_prompt: 'jargon',
		} as never);
		const after = expectOk(await settings.get(WHISPERING_SETTINGS_ROW_ID));
		expect(after?.settings_transcription_prompt).toBe('jargon');
		expect(after?.settings_transcription_language).toBe('en');
		expect(changes).toBeGreaterThan(0);
		stop();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('two borrowed lenses compose recordings CRUD with application ordering', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-data-composition-'));
	try {
		await using epicenter = await openBunEpicenter({ directory: root });
		const recordings = epicenter.bind(
			defineLens({
				namespace: 'so.epicenter.whispering',
				tables: { recordings: recordingsTable },
			}),
		).recordings;
		const settings = epicenter.bind(
			defineLens({
				namespace: 'so.epicenter.whispering',
				tables: { settings: defineTable({ fields: whisperingSettingFields }) },
			}),
		).settings;
		const older = await recordings.create(
			recording(
				'older',
				InstantString.fromDate(new Date('2026-07-20T01:00:00.000Z')),
			),
		);
		const newer = await recordings.create(
			recording(
				'newer',
				InstantString.fromDate(new Date('2026-07-20T02:00:00.000Z')),
			),
		);
		const scanned = await recordings.scan();
		expect(
			scanned.rows.toSorted((left, right) =>
				right.recordedAt.localeCompare(left.recordedAt),
			)[0],
		).toEqual(newer);
		expect(
			expectOk(await recordings.patch(older.id, { title: 'updated' }))?.title,
		).toBe('updated');
		expect(await recordings.delete(newer.id)).toBe(true);
		expect(expectOk(await recordings.get(newer.id))).toBeUndefined();
		await settings.create(WHISPERING_SETTINGS_ROW_ID, {
			...whisperingSettingRow(createWhisperingSettingDefaults('Groq')),
			settings_transcription_language: 'fr',
		} as never);
		expect(
			expectOk(await settings.get(WHISPERING_SETTINGS_ROW_ID))
				?.settings_transcription_language,
		).toBe('fr');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('first sign-in freezes attachment and converges through the in-process authority', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-data-attach-'));
	const authority = createBunEpicenterSyncRuntime({
		dir: join(root, 'authority'),
	});
	try {
		await using first = await openBunEpicenter({
			directory: join(root, 'first'),
		});
		await using second = await openBunEpicenter({
			directory: join(root, 'second'),
		});
		const settingsLens = defineLens({
			namespace: 'so.epicenter.whispering',
			tables: { settings: defineTable({ fields: whisperingSettingFields }) },
		});
		const firstSettings = first.bind(settingsLens).settings;
		const secondSettings = second.bind(settingsLens).settings;
		await firstSettings.create(WHISPERING_SETTINGS_ROW_ID, {
			...whisperingSettingRow(createWhisperingSettingDefaults('Groq')),
			settings_transcription_language: 'de',
		} as never);
		const attachment = Object.freeze({
			deploymentId: 'https://example.com/',
			principalId: 'principal-a',
		});
		const exchange = authority.locateAuthority('principal-a' as never);
		expectOk(await first.attachSync({ ...attachment, exchange }));
		expectOk(await second.attachSync({ ...attachment, exchange }));
		expect(
			expectOk(await secondSettings.get(WHISPERING_SETTINGS_ROW_ID))
				?.settings_transcription_language,
		).toBe('de');
		const refused = await second.attachSync({
			deploymentId: attachment.deploymentId,
			principalId: 'principal-b',
			exchange: authority.locateAuthority('principal-b' as never),
		});
		expect(refused.error?.name).toBe('WrongAttachment');
	} finally {
		authority.close();
		rmSync(root, { recursive: true, force: true });
	}
});
