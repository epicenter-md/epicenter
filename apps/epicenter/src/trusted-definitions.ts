/**
 * The data definitions this release ships, as values (ADR-0313).
 *
 * A definition is authored in TypeScript and the host imports the module. There
 * is no `database.json`, no serialized declaration on the wire, and no runtime
 * catalog scan: an application sends its definition IDENTITY through
 * `data-open`, and this table is what the host answers from.
 *
 * **First-party only.** ADR-0313 reverses ADR-0179's refusal to read
 * application source exactly this far and no further. A third-party artifact is
 * not admitted this way and is not admitted at all today; the plane that would
 * change that needs its own decision about admission and artifact trust
 * (ADR-0305).
 *
 * The table lists what a running application can actually ask for. Honeycrisp
 * ships a first-party definition too, and it is deliberately absent: it opens
 * its store through its own instance seam and never reaches this protocol, so
 * an entry for it would be a row nothing can select. It earns one on the day it
 * opens through the scoped handle.
 */

import type { DataDefinition } from '@epicenter/data/definition';

/** One release-shipped definition and the application allowed to open it. */
export type TrustedDefinition = {
	/** The `createEpicenter` identity that owns this data. */
	appId: string;
	definition: DataDefinition;
};

/**
 * Empty, and expected to be (ADR-0319).
 *
 * Local Mail held the only row until ADR-0318's test was run on each of its
 * artifacts and answered no four times, which moved its account registry into
 * the application's own SQLite. Honeycrisp earns a row the day it opens through
 * the scoped handle rather than its own instance seam, and Local Mail earns one
 * the day it holds a preference, which is the first artifact it would own that
 * answers yes. A table between consumers is a table, not rot.
 */
export const TRUSTED_DEFINITIONS: readonly TrustedDefinition[] = [];

/**
 * The definition `appId` may open under `dataId`, or nothing.
 *
 * Two ways to get nothing, and they mean the same thing to the caller: this
 * release ships no such data id, or it ships one that belongs to a different
 * application. Neither is a security boundary. Every SPA on this origin is
 * fully trusted (ADR-0118), so what this actually catches is a release that
 * built an application against a data id it does not ship, which would
 * otherwise mint a store under an address no host verb can reach.
 */
export function admitData({
	appId,
	dataId,
}: {
	appId: string;
	dataId: string;
}): DataDefinition | undefined {
	return TRUSTED_DEFINITIONS.find(
		(member) => member.appId === appId && member.definition.id === dataId,
	)?.definition;
}
