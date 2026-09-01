#!/usr/bin/env bun
/**
 * Run one command under an exclusive Epicenter build lock.
 *
 * Two builds of the same app at once corrupt each other rather than failing
 * cleanly. Each SvelteKit build writes and then reads `.svelte-kit/output`, so
 * the second one deletes files the first is still reading and the first dies on
 * a missing `internal.js` or `manifest-full.js` deep inside a Vite plugin. The
 * stack trace names Vite, Rollup, and Node's ESM loader, and none of them are
 * where the problem is.
 *
 * A build starting while another runs waits for it, because the person who ran
 * it wants a build, not a diagnosis. Refusing would be the same wait with an
 * extra command in it.
 *
 * The lock is a directory, because creating one is atomic on every filesystem
 * this ships to. It holds the PID that took it, so a build killed mid-run
 * leaves a lock the next one can prove is dead and take.
 */

import { rmSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK = join(import.meta.dir, '..', '.build-lock');
const OWNER = join(LOCK, 'pid');
const POLL_MS = 500;

const command = Bun.argv.slice(2);
if (command.length === 0) {
	console.error('with-build-lock: nothing to run');
	process.exit(2);
}

/** Whether the process that took the lock is still alive to finish its build. */
async function holder(): Promise<number | null> {
	const pid = Number.parseInt(
		await readFile(OWNER, 'utf8').catch(() => ''),
		10,
	);
	if (!Number.isInteger(pid)) return null;
	try {
		process.kill(pid, 0);
		return pid;
	} catch {
		return null;
	}
}

async function acquire(): Promise<void> {
	let waitedFor: number | null = null;
	while (true) {
		try {
			await mkdir(LOCK);
			await writeFile(OWNER, String(process.pid));
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
		const owner = await holder();
		if (owner === null) {
			// Nobody is finishing this build. Clear it and race for it again;
			// whichever process wins `mkdir` is the one that holds it.
			await rm(LOCK, { recursive: true, force: true });
			continue;
		}
		if (owner !== waitedFor) {
			waitedFor = owner;
			console.error(
				`Waiting for the Epicenter build already running as pid ${owner}.`,
			);
		}
		await Bun.sleep(POLL_MS);
	}
}

await acquire();
let released = false;
const release = () => {
	if (released) return;
	released = true;
	// Synchronous: this also runs from a signal handler, where the process may
	// not live long enough to await anything.
	try {
		rmSync(LOCK, { recursive: true, force: true });
	} catch {}
};
process.on('exit', release);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
	process.on(signal, () => {
		release();
		process.exit(130);
	});
}

const child = Bun.spawn(command, {
	stdin: 'inherit',
	stdout: 'inherit',
	stderr: 'inherit',
});
const code = await child.exited;
release();
process.exit(code);
