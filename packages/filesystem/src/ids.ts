import {
	type Guid,
	generateGuid,
	generateId,
	type Id,
} from '@epicenter/workspace';
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

/** Branded file identifier — a Guid that is specifically a file ID */
export type FileId = Guid & Brand<'FileId'>;
export const FileId = type('string').as<FileId>();

/** Generate a new unique file identifier */
export function generateFileId(): FileId {
	return generateGuid() as FileId;
}

/** Branded row identifier — a 10-char nanoid that is specifically a row ID */
export type RowId = Id & Brand<'RowId'>;

/** Generate a new unique row identifier */
export function generateRowId(): RowId {
	return generateId() as RowId;
}

/** Branded column identifier — a 10-char nanoid that is specifically a column ID */
export type ColumnId = Id & Brand<'ColumnId'>;

/** Generate a new unique column identifier */
export function generateColumnId(): ColumnId {
	return generateId() as ColumnId;
}
