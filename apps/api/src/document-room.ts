import { stateVectorsEqual } from '@epicenter/sync';
import * as Y from 'yjs';
import { BaseSyncRoom } from './base-sync-room';

/**
 * Durable Object for content documents (`gc: false`).
 *
 * Uses `gc: false` to preserve delete history, enabling lightweight metadata
 * snapshots for version history. `Y.snapshot(doc)` returns a state vector +
 * delete set (~7 bytes to ~1.5 KB) that can reconstruct any past doc state
 * from the retained struct store. Auto-saves a snapshot when the last
 * WebSocket disconnects, but only if the document changed since the last save.
 */
export class DocumentRoom extends BaseSyncRoom {
	private lastSavedSv: Uint8Array | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env, { gc: false });

		ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS snapshots (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				snapshot BLOB NOT NULL,
				label TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
	}

	protected override onAllDisconnected(): void {
		const currentSv = Y.encodeStateVector(this.doc);
		if (!this.lastSavedSv || !stateVectorsEqual(currentSv, this.lastSavedSv)) {
			this.lastSavedSv = currentSv;
			this.saveSnapshot('Auto-save');
		}
	}

	// --- Snapshot RPCs ---

	/** Save a lightweight metadata snapshot of the current doc state. */
	async saveSnapshot(
		label?: string,
	): Promise<{ id: number; createdAt: string }> {
		const snap = Y.snapshot(this.doc);
		const encoded = Y.encodeSnapshot(snap);
		const row = this.ctx.storage.sql
			.exec(
				'INSERT INTO snapshots (snapshot, label) VALUES (?, ?) RETURNING id, created_at',
				encoded,
				label ?? null,
			)
			.one();
		return { id: row.id as number, createdAt: row.created_at as string };
	}

	/** List all snapshots (metadata only, no reconstruction). */
	async listSnapshots(): Promise<
		Array<{ id: number; label: string | null; createdAt: string }>
	> {
		return this.ctx.storage.sql
			.exec('SELECT id, label, created_at FROM snapshots ORDER BY id DESC')
			.toArray()
			.map((row) => ({
				id: row.id as number,
				label: row.label as string | null,
				createdAt: row.created_at as string,
			}));
	}

	/** Reconstruct a past doc state from a snapshot. Returns full state as binary update. */
	async getSnapshot(snapshotId: number): Promise<Uint8Array | null> {
		const [row] = this.ctx.storage.sql
			.exec('SELECT snapshot FROM snapshots WHERE id = ?', snapshotId)
			.toArray();
		if (!row) return null;

		const snap = Y.decodeSnapshot(new Uint8Array(row.snapshot as ArrayBuffer));
		const restoredDoc = Y.createDocFromSnapshot(this.doc, snap);
		return Y.encodeStateAsUpdateV2(restoredDoc);
	}


	/** Delete a snapshot by ID. Returns true if a row was removed. */
	async deleteSnapshot(snapshotId: number): Promise<boolean> {
		const rowsDeleted = this.ctx.storage.sql.exec(
			'DELETE FROM snapshots WHERE id = ?',
			snapshotId,
		).rowsWritten;
		return rowsDeleted > 0;
	}
}
