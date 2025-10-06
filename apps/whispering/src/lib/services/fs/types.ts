import { createTaggedError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export const { FsServiceError, FsServiceErr } =
	createTaggedError('FsServiceError');
export type FsServiceError = ReturnType<typeof FsServiceError>;

export type FsService = {
	pathToBlob: (path: string) => Promise<Result<Blob, FsServiceError>>;
	pathToFile: (path: string) => Promise<Result<File, FsServiceError>>;
	pathsToFiles: (paths: string[]) => Promise<Result<File[], FsServiceError>>;
};
