/**
 * Daemon Lease Tests
 *
 * Verifies that the SQLite-backed daemon lease is the single ownership
 * primitive for project daemon startup.
 *
 * Key behaviors:
 * - first claimant owns the lease while its transaction stays open
 * - second claimant receives AlreadyRunning while the first lease is held
 * - releasing the first lease allows a later daemon to claim ownership
 * - release is idempotent and acquisition setup failures return LeaseFailed
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectErr, expectOk } from '@epicenter/test-utils/result';

import { claimDaemonLease } from './lease.js';

function setup() {
	const oldXdg = process.env.XDG_RUNTIME_DIR;
	const runtimeRoot = mkdtempSync(join(tmpdir(), 'ep-lease-runtime-'));
	const workDir = mkdtempSync(join(tmpdir(), 'ep-lease-dir-'));
	process.env.XDG_RUNTIME_DIR = runtimeRoot;

	return {
		workDir,
		cleanup() {
			if (oldXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
			else process.env.XDG_RUNTIME_DIR = oldXdg;
			rmSync(runtimeRoot, { recursive: true, force: true });
			rmSync(workDir, { recursive: true, force: true });
		},
	};
}

describe('claimDaemonLease', () => {
	test('second claimant receives AlreadyRunning while first lease is held', () => {
		const { workDir, cleanup } = setup();
		const first = claimDaemonLease(workDir);
		try {
			expectOk(first);

			const error = expectErr(claimDaemonLease(workDir));
			expect(error.name).toBe('AlreadyRunning');
		} finally {
			if (first.error === null) first.data.release();
			cleanup();
		}
	});

	test('release allows a later claimant to acquire the lease', () => {
		const { workDir, cleanup } = setup();
		try {
			const first = expectOk(claimDaemonLease(workDir));
			expect(existsSync(first.leasePath)).toBe(true);
			first.release();

			const second = claimDaemonLease(workDir);
			try {
				expectOk(second);
			} finally {
				if (second.error === null) second.data.release();
			}
		} finally {
			cleanup();
		}
	});

	test('release is idempotent and leaves the lease claimable', () => {
		const { workDir, cleanup } = setup();
		try {
			const first = expectOk(claimDaemonLease(workDir));
			first.release();
			expect(() => first.release()).not.toThrow();

			const second = expectOk(claimDaemonLease(workDir));
			second.release();
		} finally {
			cleanup();
		}
	});

	test('runtime directory setup failure returns LeaseFailed', () => {
		const oldXdg = process.env.XDG_RUNTIME_DIR;
		const runtimeRootFile = join(
			tmpdir(),
			`ep-lease-runtime-file-${Date.now()}-${Math.random()
				.toString(36)
				.slice(2, 8)}`,
		);
		const workDir = mkdtempSync(join(tmpdir(), 'ep-lease-dir-'));
		writeFileSync(runtimeRootFile, 'not a directory');
		process.env.XDG_RUNTIME_DIR = runtimeRootFile;

		try {
			const error = expectErr(claimDaemonLease(workDir));
			expect(error.name).toBe('LeaseFailed');
		} finally {
			if (oldXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
			else process.env.XDG_RUNTIME_DIR = oldXdg;
			rmSync(runtimeRootFile, { force: true });
			rmSync(workDir, { recursive: true, force: true });
		}
	});
});
