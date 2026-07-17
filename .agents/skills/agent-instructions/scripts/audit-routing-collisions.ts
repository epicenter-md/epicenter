#!/usr/bin/env bun

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultSkillsDir = join(scriptDir, '..', '..');

const phrase = process.argv.slice(2).join(' ').trim();

if (!phrase) {
	console.error(
		'Usage: bun run .agents/skills/agent-instructions/scripts/audit-routing-collisions.ts "trigger phrase"',
	);
	process.exit(2);
}

const skillDirs = await readdir(defaultSkillsDir, { withFileTypes: true });
const matches: string[] = [];

for (const entry of skillDirs) {
	if (!entry.isDirectory()) {
		continue;
	}

	const skillPath = join(defaultSkillsDir, entry.name, 'SKILL.md');
	const contents = await readFile(skillPath, 'utf8').catch((error: unknown) => {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return null;
		}

		throw error;
	});

	if (contents === null) {
		continue;
	}

	const description = extractFrontmatterField(contents, 'description');
	if (description.toLowerCase().includes(phrase.toLowerCase())) {
		matches.push(entry.name);
	}
}

for (const skill of matches) {
	console.log(`${phrase} -> ${skill}/SKILL.md`);
}

if (matches.length === 1) {
	process.exit(0);
}

if (matches.length === 0) {
	console.error(`No skill description claims "${phrase}".`);
	process.exit(1);
}

console.error(
	`Routing collision: ${matches.length} skill descriptions claim "${phrase}".`,
);
process.exit(1);

function extractFrontmatterField(markdown: string, fieldName: string): string {
	const lines = markdown.split(/\r?\n/);
	if (lines[0] !== '---') {
		return '';
	}

	const fieldPrefix = `${fieldName}:`;
	const values: string[] = [];
	let isReadingField = false;

	for (const line of lines.slice(1)) {
		if (line === '---') {
			break;
		}

		const startsNewField = /^[A-Za-z0-9_-]+:/.test(line);
		if (startsNewField) {
			if (isReadingField) {
				break;
			}

			if (line.startsWith(fieldPrefix)) {
				isReadingField = true;
				values.push(line.slice(fieldPrefix.length).trim());
			}

			continue;
		}

		if (isReadingField) {
			values.push(line.trim());
		}
	}

	return values.join(' ').replace(/^['"]|['"]$/g, '');
}
