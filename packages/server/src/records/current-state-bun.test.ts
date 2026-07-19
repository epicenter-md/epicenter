/**
 * Bun Account Authority Runtime Tests
 *
 * Verifies persistent per-principal account authorities through the Bun
 * runtime's route-facing locator.
 *
 * Key behaviors:
 * - first push registers a client-owned retry identity idempotently
 * - accepted current state and receipts survive runtime reopen
 * - principals own independent SQLite authorities; workspaces share one
 * - accepted pushes compact to the predictable retained sequence window
 * - first open deletes the authorized legacy authority tables
 * - shutdown closes active document sockets and every database
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asPrincipalId, type PrincipalId } from '@epicenter/identity';
import {
	CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
	type CurrentStateWireRowIntent,
	rowRoundDigest,
} from '@epicenter/row-sync';
import type { BunWorkspaceDocumentSocketData } from './current-state-bun.js';
import { createBunAccountAuthorityRuntime } from './current-state-bun.js';
import type { AccountAuthority } from './current-state-contracts.js';

const alice = asPrincipalId('alice');
const WORKSPACE = 'wiki';

const rid = (value: number) => value.toString(36).padStart(24, '0');

function setup() {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-current-rows-'));
	const opened = createBunAccountAuthorityRuntime({ dir });
	return {
		dir,
		...opened,
		authority(principalId: PrincipalId = alice): AccountAuthority {
			return opened.authorities.authority(principalId);
		},
		cleanup() {
			opened.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

async function push(
	authority: AccountAuthority,
	workspaceId: string,
	replicaId: string,
	round: number,
	intents: CurrentStateWireRowIntent[],
) {
	return authority.push(workspaceId, {
		protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
		kind: 'push',
		replicaId,
		round,
		requestDigest: rowRoundDigest(intents),
		intents,
	});
}

test('hasReplica observes first-push registration', async () => {
	const context = setup();
	try {
		const authority = context.authority();
		expect(await authority.hasReplica(WORKSPACE, rid(100))).toBe(false);
		const intents = [
			{ kind: 'create', table: 'pages', rowId: rid(1), fields: { n: 1 } },
		] satisfies CurrentStateWireRowIntent[];
		const accepted = await push(authority, WORKSPACE, rid(100), 1, intents);
		expect(await authority.hasReplica(WORKSPACE, rid(100))).toBe(true);
		expect(await push(authority, WORKSPACE, rid(100), 1, intents)).toEqual(
			accepted,
		);
	} finally {
		context.cleanup();
	}
});

test('accepted state and receipts survive closing and reopening', async () => {
	const context = setup();
	try {
		const replicaId = rid(100);
		const intents: CurrentStateWireRowIntent[] = [
			{
				kind: 'create',
				table: 'pages',
				rowId: rid(1),
				fields: { title: 'Persisted' },
			},
		];
		const accepted = await push(
			context.authority(),
			WORKSPACE,
			replicaId,
			1,
			intents,
		);
		expect(accepted).toMatchObject({
			result: 'accepted',
			receipt: { acceptedRound: 1, appliedThrough: 1 },
		});
		context.close();

		const reopened = createBunAccountAuthorityRuntime({ dir: context.dir });
		try {
			const authority = reopened.authorities.authority(alice);
			expect(
				await authority.push(WORKSPACE, {
					protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
					kind: 'push',
					replicaId,
					round: 1,
					requestDigest: rowRoundDigest(intents),
					intents,
				}),
			).toEqual(accepted);
			const acquired = await authority.acquire(WORKSPACE, {
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'acquire',
				replicaId,
			});
			expect(acquired).toMatchObject({
				result: 'page',
				rows: [
					{
						table: 'pages',
						rowId: rid(1),
						fields: { title: 'Persisted' },
					},
				],
			});
		} finally {
			reopened.close();
		}
	} finally {
		context.cleanup();
	}
});

test('principals and workspaces own independent authority state', async () => {
	const context = setup();
	try {
		const targets = [
			[alice, WORKSPACE, rid(1)],
			[asPrincipalId('bob'), WORKSPACE, rid(2)],
			[alice, 'notes', rid(3)],
		] as const;
		for (const [principalId, workspaceId, rowId] of targets) {
			await push(context.authority(principalId), workspaceId, rid(100), 1, [
				{
					kind: 'create',
					table: 'pages',
					rowId,
					fields: { title: rowId },
				},
			]);
		}
		for (const [principalId, workspaceId, rowId] of targets) {
			const acquired = await context
				.authority(principalId)
				.acquire(workspaceId, {
					protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
					kind: 'acquire',
					replicaId: rid(100),
				});
			expect(
				acquired.result === 'page' && acquired.rows.map((row) => row.rowId),
			).toEqual([rowId]);
		}
	} finally {
		context.cleanup();
	}
});

test('workspaces under one principal share one database and delete independently', async () => {
	const context = setup();
	try {
		const authority = context.authority();
		await push(authority, WORKSPACE, rid(100), 1, [
			{ kind: 'create', table: 'pages', rowId: rid(1), fields: { n: 1 } },
		]);
		await push(authority, 'notes', rid(100), 1, [
			{ kind: 'create', table: 'pages', rowId: rid(2), fields: { n: 2 } },
		]);

		expect(
			readdirSync(join(context.dir, 'principals', 'alice')).filter((name) =>
				name.endsWith('.sqlite'),
			),
		).toEqual(['authority.sqlite']);
		await authority.deleteWorkspace(WORKSPACE);
		expect(await authority.hasReplica(WORKSPACE, rid(100))).toBe(false);
		expect(
			await authority.acquire('notes', {
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'acquire',
				replicaId: rid(100),
			}),
		).toMatchObject({
			result: 'page',
			rows: [{ rowId: rid(2), fields: { n: 2 } }],
		});
	} finally {
		context.cleanup();
	}
});

test('workspace deletion closes upgraded document sockets before their handshake', async () => {
	const context = setup();
	const closes: { code: number; reason: string }[] = [];
	const socket = {
		data: {
			surface: 'workspace-document',
			kind: 'document',
			principalId: alice,
			workspaceId: WORKSPACE,
			address: { table: 'pages', rowId: rid(1) },
			authorizationExpiresAt: Date.now() + 60_000,
			connected: false,
		} satisfies BunWorkspaceDocumentSocketData,
		close(code: number, reason: string) {
			closes.push({ code, reason });
		},
	};
	try {
		context.websocket.open?.(socket as never);
		await context.authority().deleteWorkspace(WORKSPACE);
		expect(closes).toEqual([{ code: 1000, reason: 'not-live' }]);
	} finally {
		context.cleanup();
	}
});

test('shutdown closes active document sockets and refuses later operations', async () => {
	const context = setup();
	const closes: { code: number; reason: string }[] = [];
	const socket = {
		data: {
			surface: 'workspace-document',
			kind: 'document',
			principalId: alice,
			workspaceId: WORKSPACE,
			address: { table: 'pages', rowId: rid(1) },
			authorizationExpiresAt: Date.now() + 60_000,
			connected: false,
		} satisfies BunWorkspaceDocumentSocketData,
		close(code: number, reason: string) {
			closes.push({ code, reason });
		},
	};
	try {
		context.websocket.open?.(socket as never);
		context.close();
		expect(closes).toEqual([{ code: 1001, reason: 'server-shutdown' }]);
		expect(context.authority().hasReplica(WORKSPACE, rid(100))).rejects.toThrow(
			'closed',
		);
	} finally {
		rmSync(context.dir, { recursive: true, force: true });
	}
});

test('account deletion removes principal storage, closes sockets, and retries idempotently', async () => {
	const context = setup();
	const closes: { code: number; reason: string }[] = [];
	const socket = {
		data: {
			surface: 'workspace-document',
			kind: 'document',
			principalId: alice,
			workspaceId: WORKSPACE,
			address: { table: 'pages', rowId: rid(1) },
			authorizationExpiresAt: Date.now() + 60_000,
			connected: false,
		} satisfies BunWorkspaceDocumentSocketData,
		close(code: number, reason: string) {
			closes.push({ code, reason });
		},
	};
	try {
		const authority = context.authority();
		await push(authority, WORKSPACE, rid(100), 1, [
			{ kind: 'create', table: 'pages', rowId: rid(1), fields: { n: 1 } },
		]);
		const otherAuthority = context.authority(asPrincipalId('bob'));
		await push(otherAuthority, WORKSPACE, rid(200), 1, [
			{ kind: 'create', table: 'pages', rowId: rid(2), fields: { n: 2 } },
		]);
		context.websocket.open?.(socket as never);

		await authority.deleteAccount();
		expect(closes).toEqual([{ code: 1000, reason: 'not-live' }]);
		expect(readdirSync(join(context.dir, 'principals'))).toEqual(['bob']);
		// Idempotent retry after a partial cross-system failure.
		await authority.deleteAccount();
		// The other principal's authority is untouched.
		expect(await otherAuthority.hasReplica(WORKSPACE, rid(200))).toBe(true);
	} finally {
		context.cleanup();
	}
});

test('principal ids cannot escape their principal directory', async () => {
	const context = setup();
	try {
		await context.authority(asPrincipalId('..')).hasReplica('..', rid(100));
		expect(readdirSync(join(context.dir, 'principals'))).toEqual(['%2E%2E']);
		expect(readdirSync(join(context.dir, 'principals', '%2E%2E'))).toContain(
			'authority.sqlite',
		);
	} finally {
		context.cleanup();
	}
});

test('accepted pushes retain the newest one thousand sequences', async () => {
	const context = setup();
	try {
		const authority = context.authority();
		const replicaId = rid(100);
		let round = 0;
		let remaining = 1_001;
		while (remaining > 0) {
			const count = Math.min(64, remaining);
			const intents = Array.from(
				{ length: count },
				(): CurrentStateWireRowIntent => ({
					kind: 'update',
					table: 'pages',
					rowId: rid(999),
					fields: { set: { absent: true }, unset: [] },
				}),
			);
			round += 1;
			const response = await push(
				authority,
				WORKSPACE,
				replicaId,
				round,
				intents,
			);
			expect(response.result).toBe('accepted');
			remaining -= count;
		}

		expect(
			await authority.pull(WORKSPACE, {
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'pull',
				replicaId,
				after: 0,
			}),
		).toMatchObject({
			result: 'acquisition-required',
			retentionFloor: 1,
		});
	} finally {
		context.cleanup();
	}
});

test('first authority open deletes legacy authority tables', async () => {
	const context = setup();
	try {
		context.close();
		const principalDir = join(context.dir, 'principals', 'alice');
		mkdirSync(principalDir, { recursive: true });
		const filename = join(principalDir, 'authority.sqlite');
		const database = new Database(filename);
		database.run('CREATE TABLE row_sync_meta (id INTEGER PRIMARY KEY)');
		database.run('INSERT INTO row_sync_meta(id) VALUES (1)');
		database.close();

		const reopened = createBunAccountAuthorityRuntime({ dir: context.dir });
		try {
			await reopened.authorities
				.authority(alice)
				.hasReplica(WORKSPACE, rid(100));
		} finally {
			reopened.close();
		}

		const inspected = new Database(filename, {
			readonly: true,
		});
		try {
			expect(
				inspected
					.query<{ name: string }, []>(
						"SELECT name FROM sqlite_master WHERE name = 'row_sync_meta'",
					)
					.all(),
			).toEqual([]);
			expect(
				inspected
					.query<{ name: string }, []>(
						"SELECT name FROM sqlite_master WHERE name = 'row_authority_meta'",
					)
					.all(),
			).toEqual([{ name: 'row_authority_meta' }]);
		} finally {
			inspected.close();
		}
	} finally {
		context.cleanup();
	}
});
