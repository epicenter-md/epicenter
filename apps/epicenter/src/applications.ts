/**
 * What a person can launch from Epicenter Home (ADR-0189).
 *
 * Two sources, one list. A compiled application ships in the release and is
 * served from its own surface route behind the host's session gate. An admitted
 * application is a member of the catalog: one immutable generation of inert
 * built folders, selected once at startup (ADR-0179). "Catalog" keeps that
 * narrower meaning everywhere; this list is not one, and admitting a folder is
 * not what puts a compiled application in it.
 *
 * What the two sources share is the only thing Home needs: an ID the host can
 * resolve to a window, and a title to show. Everything they do not share
 * (window label, capability file, how Bun serves the document) is decided by
 * the host when Home launches one, so nothing downstream branches on origin.
 *
 * Home is not in the list, for a smaller reason than it used to be: you are
 * already looking at it, so launching it is a no-op rather than a window
 * (ADR-0209). It is not above the others, it simply has no second copy to open.
 * Neither is a release-bundled placeholder document, because there is nothing
 * behind it to open. Both remain reserved surface IDs the catalog refuses to
 * admit, so "not launchable" never means "available for someone else to claim".
 */

import { SURFACE_ROUTES } from './routes.ts';
import type { AppCatalog } from './static-assets.ts';

/** One application a person can launch, however the host serves it. */
export type Application = {
	id: string;
	title: string;
};

/**
 * The compiled applications this release can launch.
 *
 * Rust holds the matching decision for its own window table
 * (`Surface::is_application`). Both sides are small closed lists rather than a
 * shared manifest, and each is checked against this one by its own tests.
 */
export const WHISPERING_APPLICATION: Application = {
	id: SURFACE_ROUTES.whispering.id,
	title: SURFACE_ROUTES.whispering.title,
};

export const HONEYCRISP_APPLICATION: Application = {
	id: SURFACE_ROUTES.honeycrisp.id,
	title: SURFACE_ROUTES.honeycrisp.title,
};

/**
 * Compiled applications, in the order Home lists them.
 *
 * This is also the list the host loads asset trees for at boot: a compiled
 * application is exactly a `dist/<id>` build the release ships, so declaring
 * one here and building it are the two halves of the same act.
 */
export const COMPILED_APPLICATIONS: readonly Application[] = [
	WHISPERING_APPLICATION,
	HONEYCRISP_APPLICATION,
];

/**
 * Compose the one list Home renders. An admitted member can never collide with
 * a compiled application: catalog derivation refuses every reserved surface ID,
 * so this concatenation needs no deduplication and no precedence rule.
 */
export function listApplications(catalog: AppCatalog): Application[] {
	return [
		...COMPILED_APPLICATIONS,
		...catalog.apps.map(({ id, title }) => ({ id, title })),
	];
}
