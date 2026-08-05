/**
 * Say what the folder is asking for, before anything is sent.
 *
 * The review step. There is no conflict to resolve and no prompt to answer
 * (ADR-0207), so this exists purely so you can look at a list and decide whether
 * to run `push`. Deletions are always listed and no flag may skip them, because
 * absence is the one intent a stray `rm` or a backup tool can express by
 * accident.
 */

import type { ScanEntry } from './scan.js';

export type StatusLine = {
	path: string;
	/** `modified`, `new`, `deleted`, or why the entry will be skipped. */
	label: string;
	/** The field names this would send, when it would send any. */
	fields: string[];
};

export type FolderStatus = {
	lines: StatusLine[];
	/** True when a push would send nothing at all. */
	quiet: boolean;
};

export function statusOf(entries: readonly ScanEntry[]): FolderStatus {
	const lines: StatusLine[] = [];

	for (const entry of entries) {
		switch (entry.kind) {
			case 'claim': {
				if (entry.plan.kind === 'unbased') {
					lines.push({ path: entry.path, label: 'unbased', fields: [] });
					break;
				}
				if (entry.plan.kind !== 'patch') break;
				const fields = [
					...Object.keys(entry.plan.set),
					...entry.plan.unset,
				].sort();
				if (fields.length === 0) break;
				lines.push({ path: entry.path, label: 'modified', fields });
				break;
			}
			case 'new': {
				lines.push({
					path: entry.path,
					label: 'new',
					fields: Object.keys(entry.fields).sort(),
				});
				break;
			}
			case 'gone': {
				lines.push({ path: entry.path, label: 'deleted', fields: [] });
				break;
			}
			case 'duplicate': {
				lines.push({ path: entry.path, label: 'duplicate id', fields: [] });
				break;
			}
			case 'refused': {
				lines.push({ path: entry.path, label: 'unreadable', fields: [] });
				break;
			}
			case 'unknown-table': {
				lines.push({ path: entry.path, label: 'unknown table', fields: [] });
				break;
			}
		}
	}

	lines.sort((left, right) => left.path.localeCompare(right.path));
	return {
		lines,
		quiet: lines.every(
			(line) =>
				line.label !== 'modified' &&
				line.label !== 'new' &&
				line.label !== 'deleted',
		),
	};
}

/** One line per entry, aligned, for a terminal. */
export function formatStatus(status: FolderStatus): string {
	if (status.lines.length === 0) return 'Nothing to push.';
	const width = Math.max(...status.lines.map((line) => line.label.length));
	return status.lines
		.map((line) => {
			const label = line.label.padEnd(width);
			const fields =
				line.fields.length === 0 ? '' : `  ${line.fields.join(', ')}`;
			return `  ${label}  ${line.path}${fields}`;
		})
		.join('\n');
}
