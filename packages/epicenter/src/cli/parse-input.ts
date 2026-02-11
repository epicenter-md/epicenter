import { readFileSync, readSync } from 'node:fs';

export type ParseInputOptions = {
	/** Positional argument (inline JSON or @file) */
	positional?: string;
	/** --file flag value */
	file?: string;
	/** Whether stdin has data (process.stdin.isTTY === false) */
	hasStdin?: boolean;
	/** Stdin content (if hasStdin) */
	stdinContent?: string;
};

export type ParseInputResult<T> =
	| { ok: true; data: T }
	| { ok: false; error: string };

function parseJson<T>(input: string): ParseInputResult<T> {
	try {
		const data = JSON.parse(input) as T;
		return { ok: true, data };
	} catch (e) {
		return {
			ok: false,
			error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}

function readJsonFile<T>(filePath: string): ParseInputResult<T> {
	try {
		const content = readFileSync(filePath, 'utf-8');
		return parseJson<T>(content);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
			return { ok: false, error: `File not found: ${filePath}` };
		}
		return {
			ok: false,
			error: `Error reading file: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}

/**
 * Parse JSON input from various sources.
 * Priority: positional > --file > stdin
 */
export function parseJsonInput<T = unknown>(
	options: ParseInputOptions,
): ParseInputResult<T> {
	// 1. Check positional (could be inline JSON or @file)
	if (options.positional) {
		if (options.positional.startsWith('@')) {
			const filePath = options.positional.slice(1);
			return readJsonFile<T>(filePath);
		}
		return parseJson<T>(options.positional);
	}

	// 2. Check --file flag
	if (options.file) {
		return readJsonFile<T>(options.file);
	}

	// 3. Check stdin
	if (options.hasStdin && options.stdinContent) {
		return parseJson<T>(options.stdinContent);
	}

	return {
		ok: false,
		error:
			'No input provided. Use inline JSON, --file, @file, or pipe via stdin.',
	};
}

/**
 * Read stdin content synchronously (for CLI use).
 * Returns undefined if stdin is a TTY (interactive).
 */
export function readStdinSync(): string | undefined {
	if (process.stdin.isTTY) return undefined;

	try {
		const chunks: Buffer[] = [];
		const fd = 0; // stdin file descriptor
		const buf = Buffer.alloc(1024);
		let bytesRead: number;

		while ((bytesRead = readSync(fd, buf, 0, buf.length, null)) > 0) {
			chunks.push(buf.subarray(0, bytesRead));
		}

		return Buffer.concat(chunks).toString('utf-8').trim() || undefined;
	} catch {
		return undefined;
	}
}
