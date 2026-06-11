import type { Table } from '@epicenter/workspace';
import { FS_ERRORS } from '../errors.js';
import type { FileId } from '../ids.js';
import type { FileRow } from '../table.js';

/** Validate a filename. Rejects path separators, null bytes, and reserved names. */
export function validateName(name: string): void {
	if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
		throw FS_ERRORS.EINVAL(`invalid filename: ${name}`);
	}
	if (name === '' || name === '.' || name === '..') {
		throw FS_ERRORS.EINVAL(`reserved filename: ${name}`);
	}
}

/**
 * Assert that no active (non-trashed) sibling has the same name.
 * Throws EEXIST if a duplicate exists.
 */
export function assertUniqueName(
	filesTable: Table<FileRow>,
	siblingIds: FileId[],
	name: string,
	excludeId?: FileId,
): void {
	const duplicate = siblingIds.find((id) => {
		if (id === excludeId) return false;
		const { data: row, error } = filesTable.get(id);
		if (error) return false; // can't determine name from invalid row
		if (row === null) return false;
		return row.name === name && row.trashedAt === null;
	});
	if (duplicate) {
		throw FS_ERRORS.EEXIST(`${name} already exists in parent`);
	}
}

/**
 * Assign display names for a set of sibling rows, disambiguating CRDT conflicts.
 * Earliest createdAt keeps the clean name; later entries get suffixed.
 */
export function disambiguateNames(rows: FileRow[]): Map<string, string> {
	const result = new Map<string, string>();
	const byName = new Map<string, FileRow[]>();

	for (const row of rows) {
		const group = byName.get(row.name) ?? [];
		group.push(row);
		byName.set(row.name, group);
	}

	for (const [name, group] of byName) {
		if (group.length === 1) {
			result.set(group[0]!.id, name);
			continue;
		}
		// Sort by createdAt: earliest keeps clean name
		group.sort((a, b) => a.createdAt - b.createdAt);
		result.set(group[0]!.id, name);
		for (let i = 1; i < group.length; i++) {
			const row = group[i];
			if (!row) continue;
			const dotIndex = name.lastIndexOf('.');
			const hasExt = dotIndex > 0;
			const base = hasExt ? name.slice(0, dotIndex) : name;
			const ext = hasExt ? name.slice(dotIndex) : '';
			result.set(row.id, `${base} (${i})${ext}`);
		}
	}
	return result;
}
