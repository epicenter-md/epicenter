/**
 * Release-built SPA assets exposed by the Bun-owned Epicenter origin.
 *
 * Two serving paths currently coexist (ADR-0153 migration state):
 *
 * - The release layout: `home/index.html` plus one directory per compiled
 *   application, loaded by {@link loadStaticAssets}. Which directories those
 *   are is the release's closed list, passed in rather than discovered, so a
 *   missing build is a boot failure instead of a silently absent application.
 * - The derived app catalog: one directory per app under a host-owned catalog
 *   root, discovered by {@link deriveAppCatalog}. IDs are the direct folder
 *   names, metadata is derived from validated output, and every member is
 *   served below `/apps/<id>/`.
 *
 * Both paths hand back the same `{ id, title, resolve }` shape and use the
 * same contained resolver, so the only structural difference is that a
 * compiled application also carries its own document for the host to gate and
 * stamp. Both resolve every request below one real directory and check again
 * after symlinks are resolved.
 */

import { readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isAppId } from '@epicenter/constants/app-data';
import mime from 'mime';

export type StaticAsset = {
	file: ReturnType<typeof Bun.file>;
	contentType: string;
	isDocument: boolean;
};

/** One derived catalog member: enough to list it and serve its static root. */
export type CatalogApp = {
	id: string;
	title: string;
	resolve(pathname: string): Promise<StaticAsset | undefined>;
};

/**
 * One compiled application's release build.
 *
 * Deliberately not an extension of {@link CatalogApp}: a compiled application
 * never enters the catalog (ADR-0179), and the two only look alike because the
 * host serves both below `/apps/<id>/`. What it has and a member does not is
 * `page`, its own document, which the host holds so it can gate it behind a
 * browser session and stamp the auth bootstrap into it. That stamp is what lets
 * the build open the host-owned replica instead of one of its own.
 */
export type CompiledApplicationAssets = {
	id: string;
	title: string;
	page: string;
	resolve(pathname: string): Promise<StaticAsset | undefined>;
};

export type EpicenterStaticAssets = {
	homePage: string;
	/** Compiled applications, in the order the release declared them. */
	applications: CompiledApplicationAssets[];
};

export type AppCatalog = {
	apps: CatalogApp[];
};

/**
 * Derive the trusted app catalog from validated build output: one directory
 * per app below `catalogRoot`. The catalog is generated, never authored. A
 * missing root is an empty catalog; an entry that breaks the output contract
 * (invalid ID, reserved ID, missing `index.html`, or a root that escapes the
 * catalog directory) is not a catalog member. What is reserved is the caller's
 * call: see `RESERVED_APP_IDS` in `app-catalog.ts`.
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
		if (!isAppId(name) || reservedIds.includes(name)) continue;

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

/**
 * Load Home's document and the build of every compiled application this
 * release declares. Unlike catalog derivation, a declared application that did
 * not build is an error rather than an omission: the release promised it, Home
 * will list it, and a 404 behind a listed row is worse than refusing to start.
 */
export async function loadStaticAssets(
	appsDist: string,
	applications: readonly { id: string; title: string }[],
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

	return {
		homePage: await Bun.file(homeIndex).text(),
		applications: await Promise.all(
			applications.map(async ({ id, title }) => {
				const appRoot = await requiredContainedDirectory(
					root,
					resolve(root, id),
					`${title} asset root`,
				);
				const index = await requiredFile(
					appRoot,
					resolve(appRoot, 'index.html'),
					`${title} index`,
				);
				return {
					id,
					title,
					page: await Bun.file(index).text(),
					resolve: createContainedResolver({
						prefix: `/apps/${id}/`,
						root: appRoot,
						index,
					}),
				};
			}),
		),
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
