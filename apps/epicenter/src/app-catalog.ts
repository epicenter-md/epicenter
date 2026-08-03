/**
 * Immutable, restart-activated storage for the derived trusted app catalog
 * (ADR-0153, ADR-0158).
 *
 * On-disk shape below one host-owned catalog root:
 *
 * ```txt
 * <catalog-root>/
 *   current                      one line: the selected generation ID
 *   generations/
 *     <generation>/              one complete, never-mutated catalog copy
 *       <app-id>/index.html ...
 * ```
 *
 * The lifecycle contract:
 *
 * - A process reads `current` exactly once at startup and binds every static
 *   resolver to that generation directory. Nothing writes into an existing
 *   generation, so the running process keeps serving the exact catalog it
 *   selected even after later promotions.
 * - Promotion copies a candidate into a dot-prefixed staging directory
 *   (materializing symlinks, so a generation never references the editable
 *   source tree), validates every member against the same derivation rules
 *   the runtime serves with, renames the staging directory to its final
 *   generation name, and only then atomically replaces `current`. A failed
 *   copy or validation leaves the selection untouched.
 * - Activation is a full Epicenter restart. There is no hot reload, no
 *   generation manager, and no automatic deletion of old generations; Git
 *   owns rollback (revert the source and republish).
 */

import { randomBytes } from 'node:crypto';
import {
	cp,
	mkdir,
	readdir,
	realpath,
	rename,
	rm,
	stat,
} from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { COMPOSED_APP_IDS } from '@epicenter/constants/app-data';
import { SURFACE_ROUTES } from './routes.ts';
import { type AppCatalog, deriveAppCatalog } from './static-assets.ts';

const CURRENT_POINTER = 'current';
const GENERATIONS_DIRECTORY = 'generations';

/**
 * The app ids a candidate folder cannot claim, because the host has already
 * issued them.
 *
 * Two reasons, one namespace. A built-in surface id is a route this host serves
 * itself (ADR-0179). A composed app id names a directory under the one data root
 * that its app already owns, and every trusted app owns one (ADR-0201), so
 * admitting `local-mail` as a folder would put two claimants on the directory
 * holding Local Mail's credentials and its undelivered intent. Both call sites
 * that admit a catalog read this one expression rather than assembling their
 * own; a call site that assembled half of it would be the whole defect.
 */
export const RESERVED_APP_IDS: readonly string[] = [
	...Object.keys(SURFACE_ROUTES),
	...COMPOSED_APP_IDS,
];

/** Sortable, opaque `<epoch-ms>-<hex>`; content addressing earns nothing here. */
const GENERATION_ID_PATTERN = /^\d+-[0-9a-f]{8}$/;

/**
 * Read the `current` pointer once and derive the catalog from that immutable
 * generation directory. A missing root, missing or malformed pointer, or a
 * pointer naming a generation that no longer exists all degrade to an empty
 * catalog: the catalog is optional host data and must not stop the desktop.
 */
export async function loadActiveAppCatalog(
	catalogRoot: string,
	{ reservedIds }: { reservedIds: readonly string[] },
): Promise<AppCatalog> {
	let pointer: string;
	try {
		pointer = (
			await Bun.file(join(catalogRoot, CURRENT_POINTER)).text()
		).trim();
	} catch {
		return { apps: [] };
	}
	if (!GENERATION_ID_PATTERN.test(pointer)) return { apps: [] };
	return deriveAppCatalog(join(catalogRoot, GENERATIONS_DIRECTORY, pointer), {
		reservedIds,
	});
}

/**
 * Validate a candidate directory of built app outputs and promote it to the
 * next-start catalog generation. Every non-dot entry below `candidateRoot`
 * must satisfy the member contract (ADR-0153 direct-folder ID, not a reserved
 * built-in surface, `index.html` present); one refused entry fails the whole
 * promotion so a typo cannot silently drop an app. The pointer is replaced
 * only after the complete generation exists. Failed copies and validations
 * clean their staging paths; a failure after the generation rename may leave
 * a complete unselected generation, never a partial selection. The new
 * generation takes effect at the next full restart.
 */
export async function promoteAppCatalogCandidate(
	catalogRoot: string,
	candidateRoot: string,
	{ reservedIds }: { reservedIds: readonly string[] },
): Promise<{ generation: string; apps: { id: string; title: string }[] }> {
	if (!(await stat(candidateRoot).catch(() => undefined))?.isDirectory()) {
		throw new Error(`Candidate catalog is not a directory: ${candidateRoot}`);
	}
	await mkdir(catalogRoot, { recursive: true });
	const candidate = await realpath(candidateRoot);
	const catalog = await realpath(catalogRoot);
	if (
		isSameOrDescendant(candidate, catalog) ||
		isSameOrDescendant(catalog, candidate)
	) {
		throw new Error(
			`Candidate catalog and host catalog directories must not overlap: ${candidateRoot}`,
		);
	}

	const generation = `${Date.now()}-${randomBytes(4).toString('hex')}`;
	const generationsRoot = join(catalog, GENERATIONS_DIRECTORY);
	const staging = join(generationsRoot, `.staging-${generation}`);
	const pointerStaging = join(catalog, `.${CURRENT_POINTER}-${generation}`);
	await mkdir(generationsRoot, { recursive: true });

	try {
		await cp(candidate, staging, {
			recursive: true,
			dereference: true,
			errorOnExist: true,
			force: false,
		});
		const expected = (await readdir(staging))
			.filter((name) => !name.startsWith('.'))
			.sort();
		const { apps } = await deriveAppCatalog(staging, { reservedIds });
		const admitted = new Set(apps.map((app) => app.id));
		const refused = expected.filter((name) => !admitted.has(name));
		if (refused.length > 0) {
			throw new Error(
				`Candidate catalog entries break the app output contract: ${refused.join(', ')}. The active catalog is unchanged.`,
			);
		}

		await rename(staging, join(generationsRoot, generation));
		await Bun.write(pointerStaging, `${generation}\n`);
		await rename(pointerStaging, join(catalog, CURRENT_POINTER));
		return { generation, apps: apps.map(({ id, title }) => ({ id, title })) };
	} catch (error) {
		await Promise.all([
			rm(staging, { recursive: true, force: true }),
			rm(pointerStaging, { force: true }),
		]);
		throw error;
	}
}

function isSameOrDescendant(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return (
		path === '' ||
		(path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
	);
}
