// Doc-hygiene check. Deterministic, fixable-in-loop, CI-optional.
//
// Scope is every `specs/` directory repo-wide (top-level plus per-app and
// per-package), matching generate-spec-history.ts: all share one
// dated-scaffolding convention and one decision home (docs/adr/), so the same
// two-state lifecycle governs them all. The glob below ('*specs/*.md') is that
// repo-wide intent, not an accident.
//
// Two smells, by design only the second needs detecting:
//
//   1. A spec in the tree that declares a TERMINAL status (Implemented,
//      Superseded, Done, Retrospective, ...). Under the current model a spec is
//      in-flight only (Draft | In Progress); "done" is deletion. A terminal
//      status means the spec should have been harvested into docs/adr/ and
//      deleted. (Smell #1 is mostly designed out by the two-state enum; this
//      catches stragglers and regressions.) The whole file is scanned, not just
//      the header: this corpus routinely declares "**Status**: Implemented" as a
//      trailing line, so a head-only window would miss the real stragglers.
//
//   2. A Proposed ADR that no in-tree spec references. That means its spec was
//      deleted, i.e. the work landed, so the ADR should be Accepted (or, if the
//      work was abandoned, superseded). This is a structural signal, not a
//      heuristic. Age is a secondary, softer signal. This guard never fires on
//      the real repo (every ADR so far was born Accepted), so it is exercised
//      against fixture repos in check-doc-hygiene.test.ts; keep that test green.
//
// Exit non-zero if anything is flagged so a review step or CI can gate on it.
// Run from repo root: bun scripts/check-doc-hygiene.ts
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const STALE_DAYS = 21;
const TODAY = new Date();

// git ls-files: tracked files only, so untracked scratch specs never trip the
// gate. execFileSync (no shell) passes the '*specs/*.md' pathspec to git
// verbatim, with no shell glob expansion to quote around.
function tracked(...pathspecs: string[]): string[] {
	return execFileSync('git', ['ls-files', ...pathspecs], { encoding: 'utf8' })
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean);
}
// Read a file, "" if it cannot be read: the gate treats unreadable as empty
// rather than crashing mid-scan.
function read(path: string): string {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return '';
	}
}
// A spec's own status text, minus fenced code blocks. Example data (a YAML
// fixture with `status: completed`, a TS field `status: string`) lives inside
// fences and must not be read as the spec's declared status.
function specProse(path: string): string {
	return read(path).replace(/```[\s\S]*?```/g, '');
}

const flags: string[] = [];

// --- Smell 1: terminal-status specs still in the tree ----------------------
// The status VALUE must START with a terminal word (after optional ~~/** markdown
// wrappers), so "Partially superseded" and "Draft (not yet implemented)" do not
// trip; only an unambiguous done/superseded does. The line may start as a block
// quote or list item because specs often carry status in copied review notes.
// Horizontal whitespace only ([ \t], never \s): the match must stay on the
// status line so a paragraph several lines below "Status:" cannot cross-match.
const TERMINAL =
	/^[ \t]*(?:>[ \t]*)?(?:[-*+][ \t]*)?[*~]*status[*~]*[ \t]*[:=][ \t]*[*~]*[ \t]*(implemented|complete|completed|done|shipped|landed|merged|accepted|approved|superseded|replaced|archived|obsolete|retrospective|reversed)\b/im;
const specFiles = tracked('*specs/*.md').filter(
	(p) => !p.endsWith('/README.md'),
);
for (const f of specFiles) {
	if (TERMINAL.test(specProse(f))) {
		flags.push(
			`SPEC TERMINAL STATUS  ${f}\n    -> harvest its decision into docs/adr/ and delete the spec (git keeps it).`,
		);
	}
}

// --- Smell 2: orphaned / stale Proposed ADRs -------------------------------
const adrDir = 'docs/adr';
const allSpecText = specFiles.map(read).join('\n');
const adrs = existsSync(adrDir)
	? readdirSync(adrDir).filter((n) => /^\d{4}.*\.md$/.test(n))
	: [];
for (const name of adrs) {
	const path = `${adrDir}/${name}`;
	// ADR status lives in the header block (template line 3); scan only the head
	// so a "Status: Accepted" mentioned later in prose or alternatives cannot
	// false-match the spec's own declared status.
	const adrHead = read(path).split('\n').slice(0, 15).join('\n');
	if (!/^\s*-?\s*\**status\**\s*[:=]\s*\**\s*proposed\b/im.test(adrHead))
		continue;
	const num = name.slice(0, 4);
	const base = name.replace(/\.md$/, '');
	const referenced =
		allSpecText.includes(base) ||
		allSpecText.includes(`ADR-${num}`) ||
		allSpecText.includes(`adr/${num}`);
	let addDate: string | null = null;
	try {
		addDate = execFileSync(
			'git',
			[
				'log',
				'--diff-filter=A',
				'-1',
				'--format=%ad',
				'--date=short',
				'--',
				path,
			],
			{ encoding: 'utf8' },
		).trim();
	} catch {
		// No add date (e.g. not yet committed): leave addDate null, skip staleness.
	}
	const ageDays = addDate
		? Math.round((TODAY.getTime() - new Date(addDate).getTime()) / 86400000)
		: null;
	if (!referenced) {
		flags.push(
			`ADR PROPOSED, ORPHANED  ${path}\n    -> no in-tree spec references it; if the work landed, flip Status to Accepted; if abandoned, supersede it.`,
		);
	} else if (ageDays !== null && ageDays > STALE_DAYS) {
		flags.push(
			`ADR PROPOSED, STALE (${ageDays}d)  ${path}\n    -> still Proposed after ${ageDays} days; flip it to Accepted once the decision is made (add an \`Unbuilt:\` line if nothing implements it yet), or supersede it.`,
		);
	}
}

// --- Report ----------------------------------------------------------------
if (flags.length === 0) {
	console.log(
		'doc-hygiene: clean (no terminal-status specs, no orphaned/stale Proposed ADRs).',
	);
	process.exit(0);
}
console.log(`doc-hygiene: ${flags.length} issue(s)\n`);
for (const f of flags) console.log('  ' + f + '\n');
process.exit(1);
