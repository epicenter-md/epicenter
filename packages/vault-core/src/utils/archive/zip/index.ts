import { strToU8, unzipSync, zipSync } from 'fflate';

export type ZipInputFile = Uint8Array | string;

export type ZipNamespace = {
	/** Create a zip archive (Uint8Array) from a map of filename->content */
	pack(
		files: Record<string, ZipInputFile>,
		options?: { level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 },
	): Promise<Uint8Array>;
	/** Extract a zip archive into a map of filename->bytes */
	unpack(bytes: Uint8Array): Promise<Record<string, Uint8Array>>;
};

function normalizeFiles(
	files: Record<string, ZipInputFile>,
): Record<string, Uint8Array> {
	const out: Record<string, Uint8Array> = {};
	for (const [name, value] of Object.entries(files)) {
		out[name] = typeof value === 'string' ? strToU8(value) : value;
	}
	return out;
}

const pack: ZipNamespace['pack'] = async (files, options) => {
	const normalized = normalizeFiles(files);
	return zipSync(normalized, { level: options?.level ?? 6 }); // default is 6
};

const unpack: ZipNamespace['unpack'] = async (bytes) => {
	return unzipSync(bytes);
};

export const ZIP = {
	pack,
	unpack,
} satisfies ZipNamespace;
