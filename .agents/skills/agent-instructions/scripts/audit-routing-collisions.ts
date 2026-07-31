#!/usr/bin/env bun

/**
 * Report every skill description that mentions one trigger phrase.
 *
 * The verdict is unchanged and is what `references/composition-audit.md`
 * documents: exactly one hit is clean routing, zero hits means the phrase has
 * no owner, two or more is a collision. The `phrase -> skill/SKILL.md` line
 * format and the exit codes are the contract; do not change them.
 *
 * `--explain` is additive. It annotates each hit with whether the sentence
 * carrying the phrase claims it or routes it elsewhere, because a description
 * that says "use collapse-pass instead" registers as a hit while meaning the
 * opposite. The annotation informs the reader; it deliberately does not change
 * the hit count or the exit code, so a caller that only reads the exit status
 * keeps its behavior.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyClaim, readSkillCatalog } from './skill-catalog';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultSkillsDir = join(scriptDir, '..', '..');

const USAGE = `Usage: bun run .agents/skills/agent-instructions/scripts/audit-routing-collisions.ts [--explain] "trigger phrase"

Reports which skill descriptions mention the phrase.

  --explain   annotate each hit as [claims] or [disclaims]

Exit codes: 0 exactly one hit, 1 zero or multiple hits, 2 usage error.`;

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
	console.log(USAGE);
	process.exit(0);
}

const isExplaining = argv.includes('--explain');
const phrase = argv
	.filter((arg) => arg !== '--explain')
	.join(' ')
	.trim();

if (!phrase) {
	console.error(USAGE);
	process.exit(2);
}

const skills = await readSkillCatalog(defaultSkillsDir);
const matches = skills.filter((skill) =>
	skill.description.toLowerCase().includes(phrase.toLowerCase()),
);

for (const skill of matches) {
	const annotation = isExplaining
		? ` [${classifyClaim(skill.description, phrase)}]`
		: '';
	console.log(`${phrase} -> ${skill.name}/SKILL.md${annotation}`);
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
