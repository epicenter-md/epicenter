import { field, jsonValue } from '@epicenter/data/definition';
/**
 * Skills data tests, against the real workspace through a memory store.
 *
 * Key behaviors:
 * - a stricter release surfaces old stored payloads until an explicit update repairs one
 * - a row's instructions persist under its own structural row id
 * - agentskills.io metadata ids round-trip as payload source ids
 */

import { expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineData } from '@epicenter/data/definition';
import {
	createMemoryRecord,
	type MemoryRecord,
	openMemory,
} from '@epicenter/data/memory';
import { InstantString } from '@epicenter/field';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { exportSkillsToDisk, importSkillsFromDisk } from './node.js';
import {
	SKILL_CONTENT,
	type SkillsData,
	skillsDefinition,
} from './workspace.js';

/** The Skills workspace as an earlier release declared it, before `sourceId`. */
const historicalSkillsWorkspace = defineData({
	id: 'so.epicenter.skills',
	kv: {},
	tables: {
		skills: {
			fields: {
				name: field.string(),
				description: field.string(),
				license: field.nullable(field.string()),
				compatibility: field.nullable(field.string()),
				metadata: field.nullable(field.json(jsonValue)),
				allowedTools: field.nullable(field.string()),
				updatedAt: field.instant(),
			},
		},
	},
});

function openSkills(record: MemoryRecord) {
	return openMemory(skillsDefinition, record);
}

async function readInstructions(
	data: SkillsData,
	skillId: string,
): Promise<string> {
	const opened = await data.tables.skills.openDocument(skillId);
	if (opened.error !== null) throw opened.error;
	using handle = opened.data;
	if (handle === undefined) throw new Error(`Skill '${skillId}' has no row`);
	return handle.get(SKILL_CONTENT).toString();
}

test('a stricter Skills workspace exposes nonconformance until an update repairs it', async () => {
	const record = createMemoryRecord();
	try {
		// One durable record, two interpretations of it: the historical workspace
		// writes a row this release cannot read, and the current one has to say so
		// rather than hide it (ADR-0125).
		const historical = await openMemory(historicalSkillsWorkspace, record);
		const oldSkill = historical.tables.skills.create({
			name: 'writing-voice',
			description: 'Write directly',
			license: null,
			compatibility: null,
			metadata: null,
			allowedTools: null,
			updatedAt: InstantString.now(),
		});
		await historical[Symbol.asyncDispose]();

		const data = await openSkills(record);
		await using _data = data;
		expect(expectOk(data.tables.skills.get('aaaaaaaaaaaaaaaaaaaaaaaa'))).toBe(
			undefined,
		);

		const error = expectErr(data.tables.skills.get(oldSkill.id));
		expect(error.issues.map(({ field }) => field)).toContain('sourceId');
		// The conforming half survives the failed read, which is what recovery is
		// composed from.
		expect(error.conforming.name).toBe('writing-voice');

		const beforeRepair = data.tables.skills.list();
		expect(beforeRepair.rows).toEqual([]);
		expect(beforeRepair.nonconforming.map(({ id }) => id)).toEqual([
			oldSkill.id,
		]);

		expectOk(
			data.tables.skills.update(oldSkill.id, {
				sourceId: 'agentskills-writing-voice',
			}),
		);
		// The write reports only that it landed; the repaired row is `get`'s
		// answer, at the same structural id.
		const repaired = expectOk(data.tables.skills.get(oldSkill.id));
		expect(repaired?.sourceId).toBe('agentskills-writing-voice');
		expect(data.tables.skills.list().nonconforming).toEqual([]);
	} finally {
		record.close();
	}
});

test("a skill's instructions live under its own row id", async () => {
	const record = createMemoryRecord();
	try {
		let writtenTo: string;
		{
			const data = await openSkills(record);
			await using _data = data;
			const written = data.tables.skills.create({
				sourceId: 'agentskills-writing-voice',
				name: 'writing-voice',
				description: 'Write directly',
				license: null,
				compatibility: null,
				metadata: null,
				allowedTools: null,
				updatedAt: InstantString.now(),
			});
			writtenTo = written.id;
			const opened = await data.tables.skills.openDocument(writtenTo);
			if (opened.error !== null) throw opened.error;
			using handle = opened.data;
			if (handle === undefined) throw new Error('the row has no document');
			const content = handle.get(SKILL_CONTENT);
			content.applyDelta(content.change.insert('Keep it concise.') as never);

			const other = data.tables.skills.create({
				sourceId: 'agentskills-other',
				name: 'other',
				description: 'Another skill',
				license: null,
				compatibility: null,
				metadata: null,
				allowedTools: null,
				updatedAt: InstantString.now(),
			});
			expect(await readInstructions(data, other.id)).toBe('');
		}

		const reopened = await openSkills(record);
		await using _reopened = reopened;
		expect(await readInstructions(reopened, writtenTo)).toBe(
			'Keep it concise.',
		);
	} finally {
		record.close();
	}
});

test('filesystem import stores the metadata id as sourceId, not as the row id', async () => {
	const record = createMemoryRecord();
	const root = mkdtempSync(join(tmpdir(), 'epicenter-skills-io-'));
	const inputRoot = join(root, 'input');
	const outputRoot = join(root, 'output');
	try {
		const skillRoot = join(inputRoot, 'writing-voice');
		mkdirSync(join(skillRoot, 'references'), { recursive: true });
		writeFileSync(
			join(skillRoot, 'SKILL.md'),
			'---\ndescription: Write directly\nmetadata:\n  id: portable-writing-voice\n---\n\nUse plain language.\n',
		);
		writeFileSync(join(skillRoot, 'references', 'examples.md'), '# Examples\n');

		const data = await openSkills(record);
		await using _data = data;
		const imported = await importSkillsFromDisk({ data, dir: inputRoot });
		expect(imported.created).toBe(1);
		expect(imported.nonconforming).toEqual([]);
		const [skill] = data.tables.skills.list().rows;
		expect(skill?.sourceId).toBe('portable-writing-voice');
		expect(skill?.id).not.toBe('portable-writing-voice');

		const exported = await exportSkillsToDisk({ data, dir: outputRoot });
		expect(exported).toMatchObject({ exported: 1, nonconforming: [] });
		const markdown = readFileSync(
			join(outputRoot, 'writing-voice', 'SKILL.md'),
			'utf8',
		);
		expect(markdown).toContain('id: portable-writing-voice');
		expect(markdown).toContain('Use plain language.');
		expect(
			readFileSync(
				join(outputRoot, 'writing-voice', 'references', 'examples.md'),
				'utf8',
			),
		).toBe('# Examples\n');
	} finally {
		record.close();
		rmSync(root, { recursive: true, force: true });
	}
});
