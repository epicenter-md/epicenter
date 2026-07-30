/**
 * Release-built SPA assets exposed by the Bun-owned Epicenter origin.
 *
 * Two serving paths currently coexist (ADR-0153 migration state):
 *
 * - The legacy closed layout: `home/index.html` plus the Whispering asset
 *   tree, loaded by {@link loadStaticAssets}.
 * - The derived app catalog: one directory per app under a host-owned catalog
 *   root, discovered by {@link deriveAppCatalog}. IDs are the direct folder
 *   names, metadata is derived from validated output, and every member is
 *   served below `/apps/<id>/` by the same contained resolver the legacy
 *   Whispering path uses. The root a process serves is one immutable
 *   generation directory selected once at startup; `app-catalog.ts` owns
 *   that selection and the promotion protocol.
 *
 * Both paths resolve every request below one real directory and check again
 * after symlinks are resolved.
 */

import { readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import mime from 'mime';

const WHISPERING_PREFIX = '/apps/whispering/';

/** The direct-folder-name contract for derived catalog app IDs (ADR-0153). */
const APP_ID_PATTERN = /^[a-z0-9-]+$/;

export type StaticAsset = {
	file: ReturnType<typeof Bun.file>;
	contentType: string;
	isDocument: boolean;
};

export type EpicenterStaticAssets = {
	homePage: string;
	whisperingPage: string;
	resolveWhispering(pathname: string): Promise<StaticAsset | undefined>;
};

/** One derived catalog member: enough to list it and serve its static root. */
export type CatalogApp = {
	id: string;
	title: string;
	resolve(pathname: string): Promise<StaticAsset | undefined>;
};

export type AppCatalog = {
	apps: CatalogApp[];
};

export function isValidAppId(value: string): boolean {
	return APP_ID_PATTERN.test(value);
}

/**
 * Derive the trusted app catalog from validated build output: one directory
 * per app below `catalogRoot`. The catalog is generated, never authored. A
 * missing root is an empty catalog; an entry that breaks the output contract
 * (invalid ID, reserved built-in ID, missing `index.html`, or a root that
 * escapes the catalog directory) is not a catalog member.
 */
export async function deriveAppCatalog(
	catalogRoot: string,
	{ reservedIds }: { reservedIds: readonly string[] },
): Promise<AppCatalog> {
	let root: string;
	try {
		root = await realpath(catalogRoot);
		if (!(await stat(root)).isDirectory()) return { apps: [] };
	} catch {
		return { apps: [] };
	}

	const apps: CatalogApp[] = [];
	const names = (await readdir(root)).sort();
	for (const name of names) {
		if (!isValidAppId(name) || reservedIds.includes(name)) continue;

		let appRoot: string;
		try {
			appRoot = await requiredContainedDirectory(
				root,
				resolve(root, name),
				`app ${name} root`,
			);
		} catch {
			continue;
		}
		const index = await containedFile(appRoot, resolve(appRoot, 'index.html'));
		if (index.kind !== 'file') continue;

		apps.push({
			id: name,
			title: documentTitle(await Bun.file(index.path).text()) ?? name,
			resolve: createContainedResolver({
				prefix: `/apps/${name}/`,
				root: appRoot,
				index: index.path,
			}),
		});
	}
	return { apps };
}

/** `<title>` from the app's own document; presentation metadata only. */
function documentTitle(page: string): string | undefined {
	const title = /<title[^>]*>([^<]*)<\/title>/i.exec(page)?.[1]?.trim();
	return title === undefined || title === '' ? undefined : title;
}

export async function loadStaticAssets(
	appsDist: string,
): Promise<EpicenterStaticAssets> {
	if (appsDist.trim() === '') {
		throw new Error(
			'EPICENTER_APPS_DIST must name the built applications directory.',
		);
	}

	const root = await requiredDirectory(appsDist, 'applications asset root');
	const homeIndex = await requiredFile(
		root,
		resolve(root, 'home', 'index.html'),
		'Home index',
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
		homePage: await Bun.file(homeIndex).text(),
		whisperingPage: await Bun.file(whisperingIndex).text(),
		resolveWhispering: createContainedResolver({
			prefix: WHISPERING_PREFIX,
			root: whisperingRoot,
			index: whisperingIndex,
		}),
	};
}

/**
 * The one contained static SPA resolver: existing files below `root` are
 * served directly, extensionless client-side routes fall back to the app
 * document, and missing generated assets stay honest 404s. Traversal,
 * separator smuggling, and symlink escape resolve to nothing. The app
 * document is flagged so the server can gate it behind an established
 * browser session and inject the identity snapshot.
 */
function createContainedResolver({
	prefix,
	root,
	index,
}: {
	prefix: string;
	root: string;
	index: string;
}): (pathname: string) => Promise<StaticAsset | undefined> {
	return async (pathname) => {
		const relativePath = containedRelativePath(pathname, prefix);
		if (relativePath === undefined) return undefined;

		const requested = relativePath === '' ? index : resolve(root, relativePath);
		const requestedFile = await containedFile(root, requested);
		if (requestedFile.kind === 'file') {
			return staticAsset(requestedFile.path, requestedFile.path === index);
		}
		if (requestedFile.kind === 'outside') return undefined;

		const lastSegment = relativePath.split('/').at(-1) ?? '';
		if (lastSegment.includes('.')) return undefined;
		return staticAsset(index, true);
	};
}

/**
 * Decode enough times to catch double-encoded separators and traversal while
 * retaining legitimate encoded filenames. URL query strings never enter this
 * function because callers pass `URL.pathname`.
 */
function containedRelativePath(
	pathname: string,
	prefix: string,
): string | undefined {
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

	if (!decoded.startsWith(prefix)) return undefined;
	const requested = decoded.slice(prefix.length);
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

function staticAsset(path: string, isDocument = false): StaticAsset {
	return {
		file: Bun.file(path),
		contentType: mime.getType(path) ?? 'application/octet-stream',
		isDocument,
	};
}
