import { createTaggedError } from 'wellcrafted/error';

type ExtensionErrorContext = {
	tableName?: string;
	rowId?: string;
	filename?: string;
	filePath?: string;
	directory?: string;
	operation?: string;
};

export const { ExtensionError, ExtensionErr } = createTaggedError(
	'ExtensionError',
).withContext<ExtensionErrorContext | undefined>();
export type ExtensionError = ReturnType<typeof ExtensionError>;
