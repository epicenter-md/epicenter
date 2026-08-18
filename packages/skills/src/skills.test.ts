/**
 * Skills data tests, against the real workspace through the Bun store.
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
import { open } from '@epicenter/data/bun';
import { InstantString } from '@epicenter/field';
import { defineDatabase } from '@epicenter/database';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { exportSkillsToDisk, importSkillsFromDisk } from './node.js';
import {
	SKILL_CONTENT,
	type SkillsData,
	skillsWorkspace,
} from './workspace.js';

/** The Skills workspace as an earlier release declared it, before `sourceId`. */
const historicalSkillsWorkspace = defineDatabase({
	id: 'so.epicenter.skills',
	tables: {
		skills: {
			name: 'string',
			description: 'string',
			updatedAt: 'string.date.iso',
		},
	},
});

async function openSkills(root: string) {
	const opened = await open(skillsWorkspace, { root });
	if (opened.error !== null) throw opened.error;
	return opened.data;
}

function readInstructions(data: SkillsData, skillId: string): string {
	const content = data.tables.skills.document(skillId)?.get(SKILL_CONTENT);
	if (content === undefined) throw new Error(`Skill '${skillId}' has no row`);
	return content.toString();
}

test('a stricter Skills workspace exposes nonconformance until an update repairs it', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-skills-'));
	try {
		// One file, two interpretations of it: the historical workspace writes a row
		// this release cannot read, and the current one has to say so rather than
		// hide it (ADR-0125).
		const historical = await open(historicalSkillsWorkspace, { root });
		if (historical.error !== null) throw historical.error;
		const oldSkill = expectOk(
			historical.data.tables.skills.create({
				name: 'writing-voice',
				description: 'Write directly',
				updatedAt: InstantString.now(),
			}),
		);
		await historical.data[Symbol.asyncDispose]();

		await using data = await openSkills(root);
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
		rmSync(root, { recursive: true, force: true });
	}
});

test("a skill's instructions live under its own row id", async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-skills-doc-'));
	try {
		let writtenTo: string;
		{
			await using data = await openSkills(root);
			const written = expectOk(
				data.tables.skills.create(
					{
						sourceId: 'agentskills-writing-voice',
						name: 'writing-voice',
						description: 'Write directly',
						updatedAt: InstantString.now(),
					},
					{ document: [SKILL_CONTENT] },
				),
			);
			writtenTo = written.id;
			const content = data.tables.skills
				.document(writtenTo)
				?.get(SKILL_CONTENT);
			if (content === undefined) throw new Error('the row has no document');
			content.applyDelta(content.change.insert('Keep it concise.') as never);

			const other = expectOk(
				data.tables.skills.create(
					{
						sourceId: 'agentskills-other',
						name: 'other',
						description: 'Another skill',
						updatedAt: InstantString.now(),
					},
					{ document: [SKILL_CONTENT] },
				),
			);
			expect(readInstructions(data, other.id)).toBe('');
		}

		await using reopened = await openSkills(root);
		expect(readInstructions(reopened, writtenTo)).toBe('Keep it concise.');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('filesystem import stores the metadata id as sourceId, not as the row id', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-skills-io-'));
	const storageRoot = join(root, 'storage');
	const inputRoot = join(root, 'input');
	const outputRoot = join(root, 'output');
	try {
		mkdirSync(storageRoot, { recursive: true });
		const skillRoot = join(inputRoot, 'writing-voice');
		mkdirSync(join(skillRoot, 'references'), { recursive: true });
		writeFileSync(
			join(skillRoot, 'SKILL.md'),
			'---\ndescription: Write directly\nmetadata:\n  id: portable-writing-voice\n---\n\nUse plain language.\n',
		);
		writeFileSync(join(skillRoot, 'references', 'examples.md'), '# Examples\n');

		await using data = await openSkills(storageRoot);
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
		rmSync(root, { recursive: true, force: true });
	}
});
