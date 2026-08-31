import {
	chmodSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { mailDataDir, presenceFilePath } from './paths.ts';

/**
 * The presence record the running `local-mail app` publishes while alive, in a
 * single global (not per-account) `0600` file at `<dataDir>/runtime.json`
 * (`presenceFilePath` in `paths.ts`, which owns every name below the app
 * directory). It exists so a same-machine, same-UID reader (today: the Vite dev
 * server injecting the bearer; later: a one-shot `sync` routed to the open app)
 * can find the running host's origin and per-launch bearer.
 *
 * This is PRESENCE, not discovery-for-spawn: no reader ever starts the host from
 * it. A stale file (the host crashed) just points at a dead port, so a reader
 * gets a connection error, never a spawned daemon. There is no `up`/`down` and
 * no election.
 *
 * `bearer` is the per-launch local API credential the web UI presents to `/api`;
 * it is NOT a Gmail token (Bun owns those end to end, in `credentials.json`).
 */
export type RuntimePresence = {
	/** The loopback origin the host serves, e.g. `http://127.0.0.1:4177`. */
	origin: string;
	/** The per-launch local API bearer. Never a Gmail token. */
	bearer: string;
	/** The host process id, so a human can tell a stale file from a live one. */
	pid: number;
};

/**
 * Write the presence file, mirroring the credential store's file discipline
 * (`token-store.ts`): the bearer is protected by mode, and `EPICENTER_DATA_DIR`
 * can point anywhere, so force `0700` on the dir and `0600` on the file even
 * when either pre-existed with looser permissions (`writeFileSync`'s `mode`
 * option is ignored for an existing file, hence the explicit `chmod`).
 */
export function writePresence(
	presence: RuntimePresence,
	dataDir: string = mailDataDir(),
): void {
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	chmodSync(dataDir, 0o700);
	const path = presenceFilePath(dataDir);
	writeFileSync(path, JSON.stringify(presence));
	chmodSync(path, 0o600);
}

/**
 * Read the presence file, or `null` if it is absent or malformed. Disk bytes are
 * untrusted, so an unparsable or wrong-shaped file reads as absent rather than
 * throwing (same posture as the token store).
 */
export function readPresence(
	dataDir: string = mailDataDir(),
): RuntimePresence | null {
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(presenceFilePath(dataDir), 'utf8'),
		);
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			typeof (parsed as RuntimePresence).origin === 'string' &&
			typeof (parsed as RuntimePresence).bearer === 'string' &&
			typeof (parsed as RuntimePresence).pid === 'number'
		) {
			return parsed as RuntimePresence;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Remove the presence file on a clean shutdown. Best-effort: the kernel does not
 * remove it on a crash, and a stale file is harmless (it names a dead port), so
 * the next launch simply overwrites it.
 */
export function clearPresence(dataDir: string = mailDataDir()): void {
	try {
		rmSync(presenceFilePath(dataDir));
	} catch {
		// Nothing to clean up, or already gone.
	}
}
