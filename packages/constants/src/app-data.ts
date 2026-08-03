/**
 * Where Epicenter stores things on a machine.
 *
 * Epicenter owns exactly one application-data root. An app receives one
 * directory below it and owns everything inside, partitioned by an identifier
 * the external authority owns and never reuses. See ADR-0201.
 *
 * Three parties choose names along that path, and each function below is one
 * hand-off between two of them: Epicenter names the root and its own
 * directories, an app names everything in its directory, and an external
 * authority names a partition. `apps/` and the partition-kind directory exist
 * because a namespace whose next name is chosen by somebody else cannot be
 * defended by the party that would have to defend it. There is no level here
 * that is not one of those hand-offs.
 *
 * These are three pure functions over strings. There is no store, no handle, no
 * registry of app directories, and no lifecycle: allocating a place is not
 * owning a store, and the host never opens, reads, or reclaims anything below
 * the directory it names.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * The `so.epicenter` bundle identity, which is what names the root on every
 * platform. It has to equal `identifier` in
 * `apps/epicenter/src-tauri/tauri.conf.json`, because the desktop host resolves
 * the same directory through Tauri; `app-data.test.ts` pins the two together.
 */
export const EPICENTER_BUNDLE_IDENTIFIER = 'so.epicenter';

/**
 * The apps that own a directory under the root. An app id is the app's own
 * stable identifier and deliberately not a surface id: Local Books has no
 * launchable surface at all, and coupling a mailbox's location to a name Home's
 * launcher owns would let a surface rename strand data (ADR-0201).
 */
export const APP_DATA_IDS = ['local-mail', 'local-books'] as const;

export type AppDataId = (typeof APP_DATA_IDS)[number];

/**
 * The ambient inputs the root is computed from, passed as a value so the
 * platform table below is a unit test rather than a machine you have to own.
 * Defaults to this process.
 */
export type DataRootSystem = {
	env: Record<string, string | undefined>;
	platform: string;
	homeDir: string;
};

/**
 * The one Epicenter application-data root. `EPICENTER_DATA_DIR` wins, for tests
 * and for a person who wants their data elsewhere; an empty value counts as
 * unset.
 *
 * Otherwise this reproduces what the desktop host resolves through Tauri, and
 * the equality is the point: a host and a CLI that disagree here write to two
 * different mailboxes. Tauri 2.11's `app_data_dir()` is `dirs::data_dir()`
 * joined with the bundle identifier, and `dirs` 6.0 resolves `data_dir()` as
 * `$HOME/Library/Application Support` on macOS, `$XDG_DATA_HOME` *only when it
 * is absolute* and `$HOME/.local/share` otherwise on Linux and other Unix, and
 * roaming `%APPDATA%` on Windows.
 *
 * Two of those clauses correct what `apps/local-mail` and `apps/local-books`
 * each do today: both honour a relative `XDG_DATA_HOME`, and neither has a
 * Windows branch, so a Windows install lands in `%USERPROFILE%\.local\share`.
 */
export function epicenterDataRoot(
	system: DataRootSystem = {
		env: process.env,
		platform: process.platform,
		homeDir: homedir(),
	},
): string {
	const override = system.env.EPICENTER_DATA_DIR;
	if (override && override.length > 0) return override;
	return join(dataDir(system), EPICENTER_BUNDLE_IDENTIFIER);
}

function dataDir({ env, platform, homeDir }: DataRootSystem): string {
	if (platform === 'darwin') {
		return join(homeDir, 'Library', 'Application Support');
	}
	if (platform === 'win32') {
		const appData = env.APPDATA;
		// `dirs` asks Windows for FOLDERID_RoamingAppData and yields nothing when
		// that fails, which Tauri turns into an error. Guessing a path here would
		// silently put a person's mail somewhere their host is not looking, so
		// this fails the same way rather than inventing a fallback.
		if (!appData || appData.length === 0) {
			throw new Error(
				'APPDATA is not set, so the Epicenter data root cannot be resolved. Set EPICENTER_DATA_DIR to name it explicitly.',
			);
		}
		return appData;
	}
	const xdg = env.XDG_DATA_HOME;
	// Absolute only, matching `dirs`. A relative XDG_DATA_HOME would otherwise
	// resolve against the working directory, so a CLI run from two places would
	// see two roots while the desktop host saw a third.
	if (xdg && isAbsolute(xdg)) return xdg;
	return join(homeDir, '.local', 'share');
}

/**
 * An app's one directory: `<root>/apps/<appId>`. The app owns everything below
 * the result and Epicenter never looks inside it (ADR-0201, ADR-0193).
 *
 * `apps/` is where naming authority changes hands. Above it Epicenter chooses
 * the names (`data`, `blobs`, `app-catalog`, and whatever it adds next); below
 * it an app does. One segment keeps a host directory added later from landing
 * on an app id, and it is the boundary the host's promise is stated against:
 * everything under `apps/` is somebody else's, all of it, by position.
 *
 * The result is a string, injected at the owner's composition root the way the
 * sidecar already computes `join(root, 'data')` and `join(root, 'blobs')`. It is
 * deliberately not a capability: the bytes are not Epicenter's to offer
 * (ADR-0181, ADR-0183).
 */
export function appDataDir(root: string, appId: AppDataId): string {
	return join(root, 'apps', appId);
}

/**
 * One partition of an app's directory: `<appDir>/<kind>/<partitionId>`.
 *
 * A partition holds everything scoped to one external account, company, or
 * tenancy, and `partitionId` must be an identifier that external authority
 * issues and never reuses.
 *
 * `kind` is the same hand-off as `apps/`, one altitude down. The app chooses
 * its root filenames (`credentials.json`, `provider.json`) and a provider
 * chooses partition ids, so one directory sits between the two namespaces
 * rather than a reserved-name rule the app would have to enforce against an
 * authority it does not control. The app picks the word (`accounts`,
 * `companies`), because only the app knows what it partitions.
 *
 * Both segments are validated as exactly one path component, which is the only
 * reason this exists rather than a bare `join`: a partition id arrives from a
 * provider callback or a command-line flag, and the Local Books call site this
 * replaced joined `realmId` verbatim.
 *
 * There is no acquisition protocol. A partition exists exactly when its
 * directory does; this function names one and creates nothing.
 */
export function partitionDir(
	appDir: string,
	kind: string,
	partitionId: string,
): string {
	assertOneSegment(kind, 'partition kind');
	assertOneSegment(partitionId, 'partition id');
	return join(appDir, kind, partitionId);
}

function assertOneSegment(segment: string, label: string): void {
	if (
		segment.length === 0 ||
		segment === '.' ||
		segment === '..' ||
		segment.includes('/') ||
		segment.includes('\\')
	) {
		throw new Error(
			`The ${label} ${JSON.stringify(segment)} cannot name a directory.`,
		);
	}
}
