/**
 * Release-built SPA assets exposed by the Bun-owned Epicenter origin.
 *
 * The directory contract is deliberately small and explicit:
 *
 * - `query/index.html`
 * - `whispering/index.html` plus its generated asset tree
 *
 * Query is currently a single-file build. Whispering is a multi-file SvelteKit
 * build, so every request is resolved below its one real directory and checked
 * again after symlinks are resolved.
 */

import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import mime from 'mime';

const WHISPERING_PREFIX = '/apps/whispering/';

export type StaticAsset = {
	file: ReturnType<typeof Bun.file>;
	contentType: string;
};

export type EpicenterStaticAssets = {
	queryPage: string;
	whisperingPage: string;
	resolveWhispering(pathname: string): Promise<StaticAsset | undefined>;
};

export async function loadStaticAssets(
	appsDist: string,
): Promise<EpicenterStaticAssets> {
	if (appsDist.trim() === '') {
		throw new Error(
			'EPICENTER_APPS_DIST must name the built applications directory.',
		);
	}

	const root = await requiredDirectory(appsDist, 'applications asset root');
	const queryIndex = await requiredFile(
		root,
		resolve(root, 'query', 'index.html'),
		'Query index',
	);
	const whisperingRoot = await requiredContainedDirectory(
		root,
		resolve(root, 'whispering'),
		'Whispering asset root',
	);
	const whisperingIndex = await requiredFile(
		whisperingRoot,
		resolve(whisperingRoot, 'index.html'),
		'Whispering index',
	);

	return {
		queryPage: await Bun.file(queryIndex).text(),
		whisperingPage: await Bun.file(whisperingIndex).text(),
		async resolveWhispering(pathname) {
			const relativePath = whisperingRelativePath(pathname);
			if (relativePath === undefined) return undefined;

			const requested =
				relativePath === ''
					? whisperingIndex
					: resolve(whisperingRoot, relativePath);
			const requestedFile = await containedFile(whisperingRoot, requested);
			if (requestedFile.kind === 'file') {
				return staticAsset(requestedFile.path);
			}
			if (requestedFile.kind === 'outside') return undefined;

			// SvelteKit's static output is an SPA. Extensionless client-side routes
			// fall back to its document; missing generated assets stay honest 404s.
			const lastSegment = relativePath.split('/').at(-1) ?? '';
			if (lastSegment.includes('.')) return undefined;
			return staticAsset(whisperingIndex);
		},
	};
}

/**
 * Decode enough times to catch double-encoded separators and traversal while
 * retaining legitimate encoded filenames. URL query strings never enter this
 * function because callers pass `URL.pathname`.
 */
function whisperingRelativePath(pathname: string): string | undefined {
	let decoded = pathname;
	for (let depth = 0; depth < 8; depth += 1) {
		if (
			decoded.includes('\\') ||
			decoded.includes('\0') ||
			/%(?:00|2f|5c)/i.test(decoded)
		) {
			return undefined;
		}
		let next: string;
		try {
			next = decodeURIComponent(decoded);
		} catch {
			return undefined;
		}
		if (next === decoded) break;
		decoded = next;
		if (depth === 7) return undefined;
	}

	if (!decoded.startsWith(WHISPERING_PREFIX)) return undefined;
	const requested = decoded.slice(WHISPERING_PREFIX.length);
	const segments = requested.split('/');
	if (
		requested.startsWith('/') ||
		segments.some(
			(segment, index) =>
				segment === '.' ||
				segment === '..' ||
				(segment === '' && index !== segments.length - 1),
		)
	) {
		return undefined;
	}
	return requested;
}

async function requiredDirectory(path: string, label: string): Promise<string> {
	let canonical: string;
	try {
		canonical = await realpath(path);
	} catch {
		throw new Error(`${label} is missing: ${path}`);
	}
	if (!(await stat(canonical)).isDirectory()) {
		throw new Error(`${label} is not a directory: ${path}`);
	}
	return canonical;
}

async function requiredContainedDirectory(
	root: string,
	path: string,
	label: string,
): Promise<string> {
	const canonical = await requiredDirectory(path, label);
	if (!isContained(root, canonical)) {
		throw new Error(`${label} escapes the applications asset root.`);
	}
	return canonical;
}

async function requiredFile(
	root: string,
	path: string,
	label: string,
): Promise<string> {
	const result = await containedFile(root, path);
	if (result.kind !== 'file') {
		throw new Error(`${label} is missing below ${root}.`);
	}
	return result.path;
}

async function containedFile(
	root: string,
	path: string,
): Promise<
	{ kind: 'file'; path: string } | { kind: 'missing' } | { kind: 'outside' }
> {
	let canonical: string;
	try {
		canonical = await realpath(path);
	} catch {
		return { kind: 'missing' };
	}
	if (!isContained(root, canonical)) return { kind: 'outside' };
	if (!(await stat(canonical)).isFile()) return { kind: 'missing' };
	return { kind: 'file', path: canonical };
}

function isContained(root: string, path: string): boolean {
	const fromRoot = relative(root, path);
	return (
		fromRoot !== '..' &&
		!fromRoot.startsWith(`..${sep}`) &&
		!isAbsolute(fromRoot)
	);
}

function staticAsset(path: string): StaticAsset {
	return {
		file: Bun.file(path),
		contentType: mime.getType(path) ?? 'application/octet-stream',
	};
}
