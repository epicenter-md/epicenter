import { type } from 'arktype';

export const IngestFileInputSchema = type({
	adapter: 'string',
	file: 'File',
});

export const ImportBundleInputSchema = type({
	files: type('Record<string, File>'),
});

export type IngestFileInput = typeof IngestFileInputSchema.infer;
export type ImportBundleInput = typeof ImportBundleInputSchema.infer;
