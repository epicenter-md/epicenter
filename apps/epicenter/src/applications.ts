/**
 * The one user-facing Epicenter application catalog (ADR-0189).
 *
 * A person opens applications. Epicenter happens to serve them two ways: a
 * compiled application ships in the release and is served from its own surface
 * route behind the host's session gate, and an admitted application is an inert
 * folder in the active catalog generation (ADR-0179). That difference decides
 * serving and window lifecycle, so it stops here. One list leaves this module,
 * Home renders one row shape over it, and one native verb opens any member.
 *
 * Home is not in the list: it is the shell the list lives in. Neither is a
 * release-bundled placeholder document, because there is nothing behind it to
 * open. Both are still reserved surface IDs that the catalog refuses to admit,
 * so "not launchable" never means "available for someone else to claim".
 */

import { SURFACE_ROUTES } from './routes.ts';
import type { AppCatalog } from './static-assets.ts';

/** One application a person can open, however the host serves it. */
export type Application = {
	id: string;
	title: string;
};

/**
 * The compiled applications this release can open, in the order Home lists
 * them. Rust holds the matching launchable decision for its own window table
 * (`Surface::is_application`); both sides are small closed lists rather than a
 * shared manifest, and each is checked against this order by its own tests.
 */
const COMPILED_APPLICATIONS: readonly Application[] = [
	{ id: SURFACE_ROUTES.whispering.id, title: SURFACE_ROUTES.whispering.title },
];

/**
 * Compose the one list Home renders. An admitted member can never collide with
 * a compiled one: derivation refuses every reserved surface ID, so this
 * concatenation needs no deduplication and no precedence rule.
 */
export function listApplications(catalog: AppCatalog): Application[] {
	return [
		...COMPILED_APPLICATIONS,
		...catalog.apps.map(({ id, title }) => ({ id, title })),
	];
}
